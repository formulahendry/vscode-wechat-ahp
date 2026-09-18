import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chmod, mkdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertLocalDesktop, isLocalDesktop, registryDirectories, isLocalSocketPath, parseEndpoint,
  discoverHosts, ownerLockAddress, OwnerLock, HostConnection, SafeError,
} from '../.test-build/core.mjs';
import { fakeHost, signal } from './helpers.mjs';

test('native platform gating allows three desktop systems but not remoting, WSL or unsupported hosts', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(isLocalDesktop({ platform, env: {}, kernelRelease: 'native-kernel' }), true);
    for (const remoteName of ['ssh-remote', 'wsl', 'dev-container', 'codespaces']) {
      assert.equal(isLocalDesktop({ platform, remoteName, env: {}, kernelRelease: 'native-kernel' }), false);
    }
  }
  assert.equal(isLocalDesktop({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, kernelRelease: 'native' }), false);
  assert.equal(isLocalDesktop({ platform: 'linux', env: {}, kernelRelease: '6.6.0-microsoft-standard-WSL2' }), false);
  assert.equal(isLocalDesktop({ platform: 'freebsd', env: {}, kernelRelease: 'native' }), false);
  assert.throws(() => assertLocalDesktop({ platform: 'linux', remoteName: 'wsl' }), /native local desktop/);
});

test('discovery uses native Stable and Insiders configuration roots, including Linux XDG', () => {
  const cases = [
    [{ platform: 'win32', home: 'C:\\Users\\example', env: { APPDATA: 'C:\\Users\\example\\AppData\\Roaming' } },
      'C:\\Users\\example\\AppData\\Roaming\\Code\\agent-host\\local-endpoint\\entries'],
    [{ platform: 'darwin', home: '/Users/example', env: {} },
      '/Users/example/Library/Application Support/Code/agent-host/local-endpoint/entries'],
    [{ platform: 'linux', home: '/home/example', env: {} },
      '/home/example/.config/Code/agent-host/local-endpoint/entries'],
    [{ platform: 'linux', home: '/home/example', env: { XDG_CONFIG_HOME: '/home/example/custom config' } },
      '/home/example/custom config/Code/agent-host/local-endpoint/entries'],
  ];
  for (const [options, expected] of cases) {
    const directories = registryDirectories(options);
    assert.equal(directories[0].directory, expected);
    assert.equal(directories[1].product, 'Code - Insiders');
    assert.equal(directories.length, 2);
    assert.equal(directories.some(item => item.directory.includes('.vscode-server')), false);
  }
  assert.throws(() => registryDirectories({ platform: 'win32', home: 'C:\\Users\\example', env: {} }), /APPDATA/);
  assert.throws(() => registryDirectories({ platform: 'linux', home: '/home/example', env: { XDG_CONFIG_HOME: 'relative' } }), /absolute path/);
  assert.throws(() => registryDirectories({ platform: 'freebsd', home: '/home/example', env: {} }), /Windows, macOS and Linux/);
});

test('socket addresses are platform-specific and reject remote/relative/control-character paths', () => {
  const entry = {
    schemaVersion: 2, type: 'editor', pid: process.pid, instanceId: 'native', protocolVersion: '0.9.0',
    connectionToken: 'TEST-ONLY-TOKEN',
  };
  for (const platform of ['darwin', 'linux']) {
    assert.equal(isLocalSocketPath('/tmp/user owned/host.sock', platform), true);
    assert.ok(parseEndpoint({ ...entry, endpoint: { type: 'socket', path: '/tmp/host.sock' } }, 'Code', platform));
    for (const path of ['relative.sock', '//remote/host.sock', '\\\\remote\\pipe\\host', '\\\\.\\pipe\\host', '/', '/tmp/socket\0hidden', '/tmp/socket\n']) {
      assert.equal(isLocalSocketPath(path, platform), false);
    }
  }
  assert.equal(isLocalSocketPath('\\\\.\\pipe\\host', 'win32'), true);
  assert.equal(isLocalSocketPath('/tmp/host.sock', 'win32'), false);
});

test('POSIX ownership lease is stable per UID across profiles and never binds a public address', async () => {
  const first = ownerLockAddress('linux', 1001, '/home/one', 'one');
  const profile = ownerLockAddress('darwin', 1001, '/different/home', 'different-name');
  assert.deepEqual(first, profile);
  assert.equal(first.host, '127.0.0.1');
  assert.ok(first.port >= 49152 && first.port <= 65535);
  assert.throws(() => ownerLockAddress('linux', -1), /user identity/);
  await assert.rejects(OwnerLock.acquire({ host: '0.0.0.0', port: 50000 }), /Invalid local/);
  const occupied = createServer(socket => socket.destroy());
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  try {
    await assert.rejects(OwnerLock.acquire({ host: '127.0.0.1', port: occupied.address().port }), /owner lock is occupied/);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('native Unix transport rejects symlink sockets without sending the Host token', { skip: process.platform === 'win32' }, async t => {
  const host = await fakeHost(t, { pipe: true });
  const alias = resolve('.test-build', `socket-alias-${randomUUID()}`);
  await symlink(host.target.endpoint.path, alias);
  try {
    await assert.rejects(HostConnection.connect({ ...host.target, endpoint: { type: 'socket', path: alias } }, signal()), /Unix socket/);
    assert.equal(host.httpRequests.length, 0);
  } finally { await unlink(alias); }
});

test('native POSIX discovery refuses group/world-writable credential records', { skip: process.platform === 'win32' }, async () => {
  const root = resolve('.test-build', `owned-registry-${randomUUID()}`);
  const directories = [root, join(root, 'Code'), join(root, 'Code', 'agent-host'), join(root, 'Code', 'agent-host', 'local-endpoint'),
    join(root, 'Code', 'agent-host', 'local-endpoint', 'entries')];
  for (const directory of directories) await mkdir(directory, { mode: 0o700 });
  const path = join(directories.at(-1), 'host.json');
  const messages = [];
  try {
    await writeFile(path, JSON.stringify({
      schemaVersion: 2, type: 'editor', pid: process.pid, instanceId: 'owned', protocolVersion: '0.9.0',
      connectionToken: 'PRIVATE-REGISTRY-TOKEN', endpoint: { type: 'tcp', host: '127.0.0.1', port: 1234 },
    }), { mode: 0o600 });
    assert.equal((await discoverHosts(root)).length, 1);
    await chmod(path, 0o666);
    assert.equal((await discoverHosts(root, text => messages.push(text))).length, 0);
    assert.ok(messages.length);
    assert.doesNotMatch(messages.join('\n'), /PRIVATE-REGISTRY/);
  } finally {
    await unlink(path);
    for (const directory of directories.reverse()) await rmdir(directory);
  }
});
