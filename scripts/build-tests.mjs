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
