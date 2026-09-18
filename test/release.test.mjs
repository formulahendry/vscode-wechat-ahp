import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('release metadata stays at 0.1.0 with an end-user English README and universal packaging', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.0');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(manifest.publisher, 'formulahendry');
  assert.equal(manifest.license, 'SEE LICENSE IN LICENSE');
  assert.match(manifest.scripts.package, /^vsce package --no-dependencies/);
  assert.doesNotMatch(manifest.scripts.package, /--target|scripts\/|skip-license|allow-package/);
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /\p{Script=Han}|local-wechat-ahp|C:\\code\\|only.{0,40}VSIX/iu);
  for (const image of ['screenshot', 'chat-vscode', 'chat-wechat']) {
    assert.ok(readme.includes(`](media/${image}.png)`));
  }
  assert.ok((await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')).includes('## [0.1.0]'));
  assert.match(await readFile(new URL('../LICENSE', import.meta.url), 'utf8'), /^MIT License/);
});

test('public PNG assets have no embedded text, EXIF or appended payload', async () => {
  const images = { icon: [256, 256], screenshot: [462, 581], 'chat-vscode': [581, 275], 'chat-wechat': [560, 431] };
  for (const [name, dimensions] of Object.entries(images)) {
    const data = await readFile(new URL(`../media/${name}.png`, import.meta.url));
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], dimensions);
    let offset = 8;
    let ended = false;
    while (offset + 12 <= data.length) {
      const size = data.readUInt32BE(offset);
      const kind = data.subarray(offset + 4, offset + 8).toString('ascii');
      assert.ok(offset + size + 12 <= data.length);
      assert.ok(!['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(kind), `${name} contains metadata`);
      offset += size + 12;
      if (kind === 'IEND') { ended = true; break; }
    }
    assert.ok(ended);
    assert.equal(offset, data.length);
  }
});
