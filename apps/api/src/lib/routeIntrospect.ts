import type { Router } from 'express';
import type { ZodTypeAny } from 'zod';

/** What the validation and permission middleware say about a route, read back when generating API docs. */
export interface RouteMeta {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  permissions?: readonly string[];
}

const META = Symbol.for('marchmaker.routeMeta');

export function tag<T extends object>(fn: T, meta: RouteMeta): T {
  (fn as Record<symbol, RouteMeta>)[META] = { ...(fn as Record<symbol, RouteMeta | undefined>)[META], ...meta };
  return fn;
}

export interface FoundRoute {
  method: string;
  path: string;
  meta: RouteMeta;
}

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: { handle: object }[] };
  name?: string;
  handle: { stack?: Layer[] };
  regexp?: RegExp;
}

const ROOT_MOUNT = /^\^\\\/\?\(\?=\\\/\|\$\)$/;
const MOUNT_TAIL = /\\\/\?\(\?=\\\/\|\$\)$/;

/** The mount path of a nested router, recovered from Express 4's compiled regexp (static mounts only). */
function mountPath(layer: Layer): string {
  const src = layer.regexp?.source ?? '';
  if (ROOT_MOUNT.test(src)) return '';
  return src.replace(/^\^/, '').replace(MOUNT_TAIL, '').replace(/\\\//g, '/');
}

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** Walks a router tree and returns every route with the metadata attached by validate() and requirePermission(). */
export function collectRoutes(router: Router, base = ''): FoundRoute[] {
  const out: FoundRoute[] = [];
  const stack = (router as unknown as { stack: Layer[] }).stack ?? [];
  for (const layer of stack) {
    if (layer.route) {
      const meta: RouteMeta = {};
      for (const h of layer.route.stack) Object.assign(meta, (h.handle as Record<symbol, RouteMeta | undefined>)[META] ?? {});
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) out.push({ method, path: toOpenApiPath(`${base}${p === '/' ? '' : p}` || '/'), meta });
        }
      }
    } else if (layer.name === 'router' && layer.handle.stack) {
      out.push(...collectRoutes(layer.handle as unknown as Router, base + mountPath(layer)));
    }
  }
  return out;
}
