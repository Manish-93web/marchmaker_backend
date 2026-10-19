import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The worker runs the API's job code, so it needs the same third-party packages. Those stay external and are
// installed in the container from the API package; only the workspace packages (shared types, email templates,
// the API source itself), which ship as source, are bundled.
const api = JSON.parse(readFileSync(new URL('../api/package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
const thirdParty = Object.keys(api.dependencies).filter((name) => !name.startsWith('@marchmaker/'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  noExternal: [/^@marchmaker\//],
  external: thirdParty,
});
