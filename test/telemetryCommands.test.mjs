import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash, withAbort } from '../.test-build/core.mjs';
import { binding, credentials, MemorySecrets, waitFor } from './helpers.mjs';
import { addNativeViewApi } from './vscodeMock.mjs';
import { fakeTelemetry, loadTelemetryExtension } from './telemetryHelpers.mjs';

function harness() {
  const commands = new Map();
  const errors = [];
  const globals = new Map();
  const secrets = new MemorySecrets();
  const fake = fakeTelemetry();
  const disposable = () => ({ dispose() {} });
  let closePanel;
  const stub = {
    StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: 1 }, env: {},
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: process.cwd(), toString: () => pathToFileURL(process.cwd()).href } }],
      onDidChangeWorkspaceFolders: disposable,
    },
    window: {
      createOutputChannel: () => ({ ...disposable(), appendLine() {}, show() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      showErrorMessage: async text => errors.push(text),
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => 'Show QR',
      createWebviewPanel: () => ({
        webview: { html: '' }, onDidDispose: callback => { closePanel = callback; return disposable(); }, dispose() {},
      }),
    },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } },
  };
  addNativeViewApi(stub);
  const extension = loadTelemetryExtension(stub, resolve('.test-build', `telemetry-commands-${process.pid}`), fake);
  const context = {
    subscriptions: [], secrets, extensionMode: stub.ExtensionMode.Production,
    extension: { packageJSON: { version: '0.1.0' } },
    globalState: { get: key => globals.get(key), update: async (key, value) => globals.set(key, value) },
  };
  return {
    stub, context, extension, errors, globals, secrets, ...fake,
    invoke: name => commands.get(`wechatAHP.${name}`)(),
    closePanel: () => closePanel(),
    async close() {
      await extension.deactivate();
      for (const subscription of context.subscriptions) subscription.dispose();
    },
  };
}

test('all extension modes use the same reporter and global consent; activation errors use a safe category', async () => {
  for (const mode of [undefined, 1, 2, 3]) {
    const h = harness();
    h.context.extensionMode = mode;
    try {
      h.extension.activate(h.context);
      await h.invoke('refreshSessions');
      assert.equal(h.reporters.length, 1);
      assert.deepEqual(h.events.map(event => event.name), ['extension.activated', 'wechatAHP.refreshSessions']);
      h.reporters[0].telemetryLevel = 'error';
      await h.invoke('connect');
      assert.deepEqual(h.events.slice(2).map(event => event.name), ['wechatAHP.connect.error']);
      h.reporters[0].telemetryLevel = 'off';
      await h.invoke('connect');
      assert.equal(h.events.length, 3);
    } finally { await h.close(); }
  }
  const h = harness();
  h.stub.window.createTreeView = () => { throw new Error('PRIVATE-ACTIVATION-ERROR'); };
  try {
    assert.throws(() => h.extension.activate(h.context), /PRIVATE-ACTIVATION/);
    await waitFor(() => h.reporters[0]?.disposed);
    assert.deepEqual(h.events.map(e => [e.name, e.properties]), [
      ['extension.activation.error', { error_category: 'unexpected' }],
    ]);
  } finally { await h.close(); }
});

test('login records declined consent, QR closure, verification cancellation, persisted success and storage failure accurately', async () => {
  const h = harness();
  const originalFetch = globalThis.fetch;
  let phase = 'success';
  let polling = false;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/get_bot_qrcode')) {
      return new Response(JSON.stringify({ qrcode: 'PRIVATE-QR', qrcode_img_content: 'PRIVATE-QR-CONTENT' }));
    }
    assert.equal(path, '/ilink/bot/get_qrcode_status');
    polling = true;
    if (phase === 'waiting') await withAbort(new Promise(() => {}), options.signal);
    return new Response(JSON.stringify(phase === 'verify' ? { status: 'need_verifycode' } : {
      status: 'confirmed', bot_token: credentials.token, ilink_bot_id: credentials.botId, ilink_user_id: credentials.ownerId,
    }));
  };
  const take = async work => {
    const start = h.events.length;
    await work();
    return h.events.slice(start);
  };
  try {
    h.extension.activate(h.context);
    assert.equal(h.reporters[0].options.ignoreUnhandledErrors, true);
    h.stub.window.showWarningMessage = async () => undefined;
    const declined = await take(() => h.invoke('login'));
    assert.deepEqual(declined.map(e => e.name), ['wechatAHP.login', 'wechatAHP.login.result']);
    assert.equal(declined.at(-1).properties.outcome, 'cancelled');
    assert.equal(declined.at(-1).measurements, undefined);
    h.stub.window.showWarningMessage = async () => 'Show QR';
    phase = 'waiting';
    const closed = await take(async () => {
      const operation = h.invoke('login');
      await waitFor(() => polling);
      h.closePanel();
      await operation;
    });
    assert.equal(closed.at(-1).properties.outcome, 'cancelled');
    assert.ok(closed.at(-1).measurements.duration_ms >= 0);
    assert.equal(h.secrets.writes.length, 0);
    polling = false;
    const stopped = await take(async () => {
      const operation = h.invoke('login');
      await waitFor(() => polling);
      await h.invoke('disconnect');
      await operation;
    });
    assert.equal(stopped.filter(e => e.name.endsWith('.result')).at(-1).properties.outcome, 'cancelled');
    phase = 'verify';
    h.stub.window.showInputBox = async () => undefined;
    const verification = await take(() => h.invoke('login'));
    assert.equal(verification.at(-1).properties.outcome, 'cancelled');
    assert.deepEqual(h.errors, []);
    phase = 'success';
    const signedIn = await take(() => h.invoke('login'));
    assert.equal(signedIn.at(-1).properties.outcome, 'success');
    assert.equal(h.secrets.state().credentials.ownerId, credentials.ownerId);
    h.secrets.fail = true;
    const failed = await take(() => h.invoke('login'));
    assert.deepEqual(failed.map(e => e.name), ['wechatAHP.login', 'wechatAHP.login.result', 'wechatAHP.login.error']);
    assert.equal(failed[1].properties.outcome, 'failed');
    assert.equal(failed[2].properties.error_category, 'storage');
    assert.ok(failed[2].measurements.duration_ms >= 0);
    const serialized = JSON.stringify(h.events);
    for (const value of [credentials.ownerId, credentials.token, credentials.botId, 'PRIVATE-QR', 'TEST-SECRET-MUST-NOT-LEAK']) {
      assert.ok(!serialized.includes(value));
    }
  } finally { await h.close(); globalThis.fetch = originalFetch; }
});

test('failed connect is a single command result/error, not a terminal background error, with no retained lock', async () => {
  const h = harness();
  h.globals.set('wechat-ahp.binding.v1', {
    ...binding, workspace: hash(JSON.stringify([pathToFileURL(process.cwd()).href])),
  });
  h.stub.window.showWarningMessage = async () => 'Connect';
  try {
    h.extension.activate(h.context);
    for (let i = 0; i < 2; i++) {
      const before = h.events.length;
      await h.invoke('connect');
      assert.deepEqual(h.events.slice(before).map(e => e.name), [
        'wechatAHP.connect', 'wechatAHP.connect.result', 'wechatAHP.connect.error',
      ]);
      assert.equal(h.events.at(-2).properties.outcome, 'failed');
      assert.equal(h.events.at(-1).properties.error_category, 'local');
      assert.match(h.errors.at(-1), /Sign in with QR first/, 'a previous failed startup must not retain ownership');
    }
    assert.equal(h.events.some(e => e.name === 'wechatAHP.channel.error'), false);
  } finally { await h.close(); }
});
