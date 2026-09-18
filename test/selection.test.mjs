import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientClosedError, RpcError, RpcTimeoutError, TransportError } from '@microsoft/agent-host-protocol/client';
import {
  Bridge, HostConnection, Inbox, bindingSchema, diagnostic, parseBinding, selectionFailure,
} from '../.test-build/core.mjs';
import { binding, fakeHost, fakeWeixin, message, MemorySecrets, signal, vault, waitFor, registryFixtureDirectories, registryEnvironment, mockOsForTests } from './helpers.mjs';
import { addNativeViewApi } from './vscodeMock.mjs';

const resources = {
  ...binding,
  session: 'copilotcli:/11111111-1111-4111-8111-111111111111',
  chat: 'ahp-chat://copilotcli/11111111-1111-4111-8111-111111111111/main',
};

test('binding preserves provider-defined session schemes and authority-bearing chat URIs without normalization', () => {
  assert.deepEqual(parseBinding(resources), resources);
  assert.deepEqual(parseBinding(binding), binding);
  const future = { ...resources, session: 'provider-next:/opaque%2Did', chat: 'provider-next://session/chat' };
  assert.deepEqual(parseBinding(future), future);
  for (const resource of [
    'https://example.test/chat', 'file:///private', 'javascript:/alert', 'command:/run',
    'ahp-root://', 'copilotcli://user:secret@host/chat', 'copilotcli:/chat?token=SECRET',
    'copilotcli:/chat#SECRET', 'copilotcli:/chat?', 'copilotcli:/chat#', 'copilotcli:/chat\n',
    'copilotcli:\\chat', 'copilotcli:/', '/relative', 'copilotcli:opaque', 'copilotcli:///chat',
  ]) {
    for (const field of ['session', 'chat']) {
      assert.equal(bindingSchema.safeParse({ ...resources, [field]: resource }).success, false, resource);
      assert.throws(() => parseBinding({ ...resources, [field]: resource }), error => {
        assert.match(diagnostic(error), new RegExp(`Invalid binding \\(${field}\\)`));
        assert.doesNotMatch(diagnostic(error), /SECRET|user:secret/);
        return true;
      });
    }
  }
});

test('provider URI is used unchanged through SDK catalog, subscription, same-chat dispatch and authorized reply', async t => {
  const host = await fakeHost(t, { resources, pipe: true });
  const fake = await fakeWeixin(t);
  const { vault: store } = await vault();
  const connection = await HostConnection.connect(host.target, signal());
  let bridge;
  t.after(async () => { await bridge?.close(); await connection.close(); });
  const catalog = await connection.listSessions(signal());
  const state = await connection.session(catalog[0].resource, signal());
  const selected = parseBinding({ ...resources, session: catalog[0].resource, chat: state.chats[0].resource });
  const inbox = new Inbox(store, selected, fake.api, () => {});
  bridge = await Bridge.open(connection, selected, inbox, signal(), () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  await bridge.deliverPending(signal());
  host.answer();
  await waitFor(() => fake.sends.length === 1);
  assert.equal(fake.sends.length, 1);
  assert.ok(host.methods.some(method => method.method === 'subscribe' && method.params.channel === resources.session));
  assert.ok(host.methods.some(method => method.method === 'subscribe' && method.params.channel === resources.chat));
  assert.ok(host.actions.filter(action => action.action.type.startsWith('chat/')).every(action => action.channel === resources.chat));
});

test('selection errors expose stage and allowlisted SDK categories/codes, never remote messages or data', () => {
  for (const [error, expected] of [
    [new RpcError(-32601, 'SECRET', { token: 'SECRET' }), /RPC error \(-32601\).*does not support/],
    [new RpcError(-32000, 'SECRET'), /RPC error \(-32000\).*rejected/],
    [new RpcTimeoutError('SECRET', 500), /timed out/],
    [new TransportError('io', 'SECRET'), /connection closed/],
    [new ClientClosedError('SECRET'), /connection closed/],
    [new TypeError('SECRET credential URL'), /TypeError/],
  ]) {
    const text = diagnostic(selectionFailure('session catalog', error));
    assert.match(text, /^Select chat \/ session catalog:/);
    assert.match(text, expected);
    assert.doesNotMatch(text, /SECRET/);
  }
});

test('malformed catalogs and RPC failures are diagnosable at the catalog stage', async t => {
  for (const options of [
    { catalog: { sessions: [] } }, { catalog: { items: [{ resource: resources.session }] } },
    { rpcError: { method: 'listSessions', code: -32601 } },
  ]) {
    const host = await fakeHost(t, options);
    const connection = await HostConnection.connect(host.target, signal());
    try {
      await assert.rejects(connection.listSessions(signal()), error => {
        const text = diagnostic(selectionFailure('session catalog', error));
        assert.match(text, /session catalog:.*(?:invalid AHP session catalog|RPC error \(-32601\))/);
        assert.doesNotMatch(text, /TEST-SECRET/);
        return true;
      });
    } finally { await connection.close(); }
  }
});

test('bundled Select Existing command saves the actual catalog URIs without Weixin or agent actions', async t => {
  const host = await fakeHost(t, { resources });
  const root = resolve('.test-build', `selection-${randomUUID()}`);
  const dirs = registryFixtureDirectories(root);
  for (const path of dirs) await mkdir(path, { mode: 0o700 });
  const entry = join(dirs.at(-1), 'fixture.json');
  await writeFile(entry, JSON.stringify({
    schemaVersion: 2, type: 'editor', pid: process.pid, instanceId: 'selection-fixture',
    protocolVersion: '0.9.0', connectionToken: host.target.connectionToken, endpoint: host.target.endpoint,
  }), { mode: 0o600 });
  const restoreEnvironment = registryEnvironment(root);
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const originalLoad = Module._load;
  const commands = new Map();
  const errors = [];
  const logs = [];
  const saved = new Map();
  const secrets = new MemorySecrets();
  const dispose = () => ({ dispose() {} });
  const stub = {
    StatusBarAlignment: { Left: 1 }, env: {},
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: process.cwd(), toString: () => pathToFileURL(process.cwd()).href } }],
      onDidChangeWorkspaceFolders: dispose,
    },
    window: {
      createOutputChannel: () => ({ ...dispose(), appendLine: line => logs.push(line), show() {} }),
      createStatusBarItem: () => ({ ...dispose(), show() {} }),
      showQuickPick: async items => items[0],
      showWarningMessage: async () => 'Save Binding',
      showErrorMessage: async text => errors.push(text),
    },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return dispose(); } },
  };
  addNativeViewApi(stub);
  let extension;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'node:os') {
        return mockOsForTests(originalLoad.call(this, request, parent, isMain), root);
      }
      return request === 'vscode' ? stub : originalLoad.call(this, request, parent, isMain);
    };
    extension = require('../dist/extension.cjs');
    Module._load = originalLoad;
    extension.activate({
      subscriptions: [], secrets,
      extension: { packageJSON: { version: '0.1.0' } },
      globalState: { get: key => saved.get(key), update: async (key, value) => saved.set(key, value) },
    });
    await commands.get('wechatAHP.selectChat')();
    assert.deepEqual(errors, []);
    assert.equal(saved.get('wechat-ahp.binding.v1').session, resources.session);
    assert.equal(saved.get('wechat-ahp.binding.v1').chat, resources.chat);
    assert.equal(host.actions.length, 0);
    assert.equal(secrets.writes.length, 0);
    assert.ok(logs.some(line => line.includes('Select chat: binding save.')));
    assert.doesNotMatch(logs.join('\n'), /TEST-ONLY|TEST-SECRET|TEST-PRIVATE/);
    let consent;
    stub.window.showWarningMessage = async text => { consent = text; return undefined; };
    await commands.get('wechatAHP.connect')();
    assert.match(consent, /TWO-WAY TEXT SYNC/);
    assert.match(consent, /New VS Code user messages and completed assistant text/);
    assert.match(consent, /No history, reasoning, tools, attachments or other chats/);
    assert.equal(host.actions.length, 0, 'cancelled consent must not register or dispatch');
  } finally {
    Module._load = originalLoad;
    await extension?.deactivate();
    restoreEnvironment();
    await unlink(entry);
    for (const path of dirs.reverse()) await rmdir(path);
  }
});
