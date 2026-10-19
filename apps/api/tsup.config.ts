import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/scripts/syncIndexes.ts'],
  format: ['esm'],
  clean: true,
  // The workspace packages (shared types and the email templates) ship as source, so they are bundled into the build.
  // Every other dependency stays external and is installed in the container.
  noExternal: [/^@marchmaker\//],
});
