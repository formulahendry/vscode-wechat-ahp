import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertSessionScope, bindingSchema, ChannelRuntime, discoverHosts, OwnerLock, parseEndpoint, pause, SafeError,
} from '../.test-build/core.mjs';
import { binding, fakeHost, message, signal, vault, waitFor } from './helpers.mjs';

for (const type of process.platform === 'win32' ? ['pipe', 'loopback'] : ['loopback']) {
  const address = () => type === 'pipe' ? `\\\\.\\pipe\\wechat-ahp-lock-test-${randomUUID()}` : { host: '127.0.0.1', port: 0 };
  test(`${type} owner lock rejects simultaneous instances and releases deterministically`, async () => {
    const first = await OwnerLock.acquire(address());
    const target = first.address;
    try { await assert.rejects(OwnerLock.acquire(target), /Another local VS Code window|owner lock is occupied/); }
    finally { await first.close(); }
    await first.close();
    const second = await OwnerLock.acquire(target);
    await second.close();
  });

  test(`${type} owner lock excludes a different process and survives owner crash without stale files`, async t => {
    const entry = pathToFileURL(resolve('.test-build', 'core.mjs')).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { OwnerLock } from ${JSON.stringify(entry)}; const lock = await OwnerLock.acquire(JSON.parse(process.argv[1])); console.log(JSON.stringify(lock.address));`,
      JSON.stringify(address())], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const output = createInterface({ input: child.stdout });
    const [line] = await Promise.race([
      once(output, 'line'),
      once(child, 'exit').then(() => { throw new Error('Lock owner exited before acquiring the lock.'); }),
    ]);
    output.close();
    const target = JSON.parse(line);
    await assert.rejects(OwnerLock.acquire(target), /Another local VS Code window|owner lock is occupied/);
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    const recovered = await OwnerLock.acquire(target);
    await recovered.close();
  });
}

test('discovery accepts only schema-v2 local TCP/named-pipe records and never arbitrary URLs', () => {
  const record = {
    schemaVersion: 2, type: 'editor', pid: 1, instanceId: 'fixture', protocolVersion: '0.9.0',
    connectionToken: 'TEST-ONLY-TOKEN', endpoint: { type: 'tcp', host: '127.0.0.1', port: 1234 },
  };
  assert.equal(parseEndpoint(record, 'Code').id, 'Code:editor:1:fixture');
  for (const endpoint of [
    { type: 'tcp', host: 'evil.test', port: 80 }, { type: 'tcp', host: '192.168.0.1', port: 80 },
    { type: 'tcp', host: '127.0.0.1', port: -1 }, { type: 'socket', path: '\\\\remote\\pipe\\host' },
    { type: 'websocket', url: 'ws://127.0.0.1/?tkn=secret' },
  ]) assert.equal(parseEndpoint({ ...record, endpoint }, 'Code'), undefined);
  assert.ok(parseEndpoint({ ...record, endpoint: { type: 'socket', path: '\\\\.\\pipe\\test-local' } }, 'Code', 'win32'));
  assert.equal(parseEndpoint({ ...record, schemaVersion: 1 }, 'Code'), undefined);
  assert.equal(parseEndpoint({ ...record, pid: 0 }, 'Code'), undefined);
  assert.equal(bindingSchema.safeParse({ ...binding, chat: 'ahp-chat:/chat?token=secret' }).success, false);
});

test('registry is re-read on every discovery; invalid records are diagnosed without tokens', async () => {
  const root = resolve('.test-build', `registry-${randomUUID()}`);
  const directories = [root, join(root, 'Code'), join(root, 'Code', 'agent-host'), join(root, 'Code', 'agent-host', 'local-endpoint'),
    join(root, 'Code', 'agent-host', 'local-endpoint', 'entries')];
  for (const path of directories) await mkdir(path, { mode: 0o700 });
  const path = join(directories.at(-1), 'host.json');
  const malformed = join(directories.at(-1), 'malformed.json');
  const logs = [];
  const entry = {
    schemaVersion: 2, type: 'editor', pid: process.pid, instanceId: 'fixture', protocolVersion: '0.9.0',
    connectionToken: 'TEST-ROTATING-1', endpoint: { type: 'tcp', host: '127.0.0.1', port: 1234 },
  };
  try {
    await writeFile(path, JSON.stringify(entry), { mode: 0o600 });
    await writeFile(malformed, '{"secret":"DO-NOT-LOG",', { mode: 0o600 });
    assert.equal((await discoverHosts(root, log => logs.push(log)))[0].connectionToken, 'TEST-ROTATING-1');
    await writeFile(path, JSON.stringify({ ...entry, connectionToken: 'TEST-ROTATING-2' }));
    assert.equal((await discoverHosts(root, log => logs.push(log)))[0].connectionToken, 'TEST-ROTATING-2');
    assert.ok(logs.length);
    assert.doesNotMatch(logs.join('\n'), /DO-NOT-LOG|TEST-ROTATING/);
  } finally {
    await unlink(path);
    await unlink(malformed);
    for (const directory of directories.reverse()) await rmdir(directory);
  }
});

test('session scope must be inside the explicitly trusted local workspace, never merely any local session', async () => {
  const root = resolve('.test-build', `scope-${randomUUID()}`);
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  await mkdir(root);
  await mkdir(allowed);
  await mkdir(outside);
  const session = { chats: [{ resource: binding.chat }], workingDirectories: [pathToFileURL(allowed).href] };
  try {
    await assertSessionScope(session, binding.chat, [allowed]);
    await assert.rejects(assertSessionScope({ ...session, workingDirectories: [pathToFileURL(outside).href] }, binding.chat, [allowed]), /different workspace/);
    await assert.rejects(assertSessionScope({ ...session, workingDirectories: ['vscode-remote://host/work'] }, binding.chat, [allowed]), /not an accessible local/);
    await assert.rejects(assertSessionScope({ chats: [] }, binding.chat, [allowed]), /Cannot establish/);
  } finally { await rmdir(allowed); await rmdir(outside); await rmdir(root); }
});

test('workspace trust prevents initialization or polling; startup failure does not masquerade as connected', async () => {
  const { vault: store } = await vault();
  const phases = [];
  const runtime = new ChannelRuntime({
    binding, vault: store, api: { updates: async () => assert.fail('must not poll') },
    resolveHost: async () => assert.fail('must not connect'),
    assertAllowed() { throw new SafeError('Workspace is untrusted.'); },
    assertScope: async () => {}, log() {}, status: phase => phases.push(phase), failed() {},
  });
  await assert.rejects(runtime.start(), /untrusted/);
  await runtime.stop();
  assert.equal(phases.includes('Connected'), false);
});

test('poll retries are bounded, and stop cancels an active long poll', async t => {
  const host = await fakeHost(t);
  const { vault: store } = await vault();
  const errors = [];
  let polls = 0;
  const base = {
    binding, vault: store, resolveHost: async () => host.target,
    assertAllowed() {}, assertScope: async () => {}, log() {}, status() {}, failed: error => errors.push(error),
    wait: (ms, signal) => pause(Math.min(ms, 1), signal), ackTimeout: 500,
  };
  const runtime = new ChannelRuntime({
    ...base, api: { updates: async () => { polls++; throw new SafeError('temporary', true); } },
  });
  await runtime.start();
  await runtime.finished;
  assert.equal(polls, 7);
  assert.match(errors[0], /six retries/);
  let cancelled = false;
  const waiting = new ChannelRuntime({
    ...base, api: { updates: async (_cursor, abort) => {
      try { await pause(100000, abort); }
      finally { cancelled = abort.aborted; }
      return { msgs: [message()] };
    } },
  });
  await waiting.start();
  await waiting.stop();
  assert.equal(cancelled, true);
  assert.equal(store.snapshot().messages.length, 0);
  assert.equal(host.actions.some(a => a.action.type === 'chat/turnCancelled'), false);
});

test('reconnect keeps per-client action sequence monotonic', async t => {
  const host = await fakeHost(t);
  const { vault: store } = await vault();
  let resolutions = 0;
  const phases = [];
  const runtime = new ChannelRuntime({
    binding, vault: store,
    api: { updates: async (_cursor, signal) => { await pause(10000, signal); return { msgs: [] }; } },
    resolveHost: async () => { resolutions++; return host.target; },
    assertAllowed() {}, assertScope: async () => {}, log() {}, status: s => phases.push(s), failed() {},
    wait: (ms, signal) => pause(Math.min(ms, 5), signal), ackTimeout: 500,
  });
  await runtime.start();
  host.disconnect();
  await waitFor(() => resolutions >= 2 && phases.filter(s => s === 'Connected').length === 2);
  await runtime.stop();
  const seqs = host.actions.map(action => action.clientSeq);
  assert.ok(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]));
  assert.equal(new Set(host.actions.map(action => action.clientId)).size, 1);
});
