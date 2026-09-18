import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

export async function writeThirdPartyLicenses(metafile) {
  const packageRoots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = normalize(input).split(sep);
    const index = parts.lastIndexOf('node_modules');
    if (index < 0) continue;
    const count = parts[index + 1].startsWith('@') ? 3 : 2;
    packageRoots.add(parts.slice(0, index + count).join(sep));
  }
  const notices = [];
  for (const root of [...packageRoots].sort()) {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const names = (await readdir(root)).filter(name => /^(?:license|licence|copying)(?:\..*)?$/i.test(name));
    let text;
    if (pkg.name === '@microsoft/agent-host-protocol') {
      text = await readFile(join('licenses', 'agent-host-protocol.txt'), 'utf8');
    } else {
      if (!names.length) throw new Error(`Missing license for bundled dependency ${pkg.name}`);
      text = (await Promise.all(names.map(name => readFile(join(root, name), 'utf8')))).join('\n\n');
    }
    notices.push(`${pkg.name} ${pkg.version} (${pkg.license})\n${'='.repeat(72)}\n${text}`);
  }
  await writeFile(join('dist', 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n\n'), 'utf8');
}
