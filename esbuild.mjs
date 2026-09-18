import { context } from 'esbuild';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeThirdPartyLicenses } from './scripts/licenses.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
if (production && watch) throw new Error('Use watch for development, not production packaging.');

const matcherPlugin = {
  name: 'vscode-build-progress',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd(result => {
      for (const [severity, messages] of [['error', result.errors], ['warning', result.warnings]]) {
        for (const { text, location } of messages) {
          const file = location?.file ?? 'esbuild.mjs';
          console.error(`${file}(${location?.line ?? 1},${(location?.column ?? 0) + 1}): ${severity}: ${text.replace(/\r?\n/g, ' ')}`);
        }
      }
      console.log('[watch] build finished');
    });
  },
};

if (production) {
  try { await unlink(join('dist', 'extension.cjs.map')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const buildContext = await context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/extension.cjs',
  external: ['vscode'],
  legalComments: 'eof',
  sourcemap: production ? false : true,
  sourcesContent: false,
  metafile: production,
  logLevel: 'silent',
  plugins: [matcherPlugin],
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
});

if (watch) {
  await buildContext.watch();
} else {
  try {
    const result = await buildContext.rebuild();
    if (production) await writeThirdPartyLicenses(result.metafile);
  } finally { await buildContext.dispose(); }
}
