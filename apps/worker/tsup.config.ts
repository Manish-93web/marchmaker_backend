import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  // Workspace packages ship as TypeScript, so they are bundled into the worker.
  noExternal: ['@marchmaker/api', '@marchmaker/shared'],
  // pdfkit loads its font metrics from disk at runtime, so it cannot be bundled.
  external: ['pdfkit'],
});
