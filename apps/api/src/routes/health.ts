import { Router } from 'express';

export interface HealthDeps {
  isReady: () => boolean | Promise<boolean>;
  version: string;
}

export function healthRouter({ isReady, version }: HealthDeps): Router {
  const r = Router();
  r.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version, uptime: Math.round(process.uptime()) });
  });
  r.get('/readyz', async (_req, res) => {
    const ready = await Promise.resolve(isReady()).catch(() => false);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });
  return r;
}
