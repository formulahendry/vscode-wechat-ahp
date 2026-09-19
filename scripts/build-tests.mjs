import { build } from 'esbuild';

await build({
  entryPoints: ['src/testing.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: '.test-build/core.mjs',
  packages: 'external',
  sourcemap: false,
});

// Keep the production SDK replaceable in command/lifecycle tests, never sending
// those tests to the real ingestion resource.
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: '.test-build/extension.cjs',
  external: ['vscode', '@vscode/extension-telemetry'],
  sourcemap: false,
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
});
