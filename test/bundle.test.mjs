import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VERSION } from '../.test-build/core.mjs';
import { credentials, MemorySecrets, mockOsForTests } from './helpers.mjs';
import { addNativeViewApi } from './vscodeMock.mjs';

test('bundled entry uses only vscode/builtins, rejects Remote and supports QR login in every local window mode', async () => {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const original = Module._load;
  const commands = new Map();
  const errors = [];
  const globals = new Map();
  const secrets = new MemorySecrets();
  const disposable = () => ({ dispose() {} });
  let telemetryLoggers = 0;
  const stub = {
    StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: 1 }, env: { remoteName: undefined },
    window: {
      createOutputChannel: () => ({ ...disposable(), appendLine() {}, show() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      showErrorMessage: async message => { errors.push(message); },
    },
    workspace: { isTrusted: false, workspaceFolders: [], onDidChangeWorkspaceFolders: disposable },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable(); } },
  };
  addNativeViewApi(stub);
  const createTelemetryLogger = stub.env.createTelemetryLogger;
  stub.env.createTelemetryLogger = (...args) => { telemetryLoggers++; return createTelemetryLogger(...args); };
  const externals = new Set();
  let extension;
  Module._load = function (request, parent, isMain) {
    externals.add(request);
    if (request === 'vscode') return stub;
    if (request === 'node:os') {
      return mockOsForTests(original.call(this, request, parent, isMain), resolve('.test-build', `bundle-user-${process.pid}`));
    }
    return original.call(this, request, parent, isMain);
  };
  try { extension = require('../dist/extension.cjs'); }
  finally { Module._load = original; }
  const context = {
    subscriptions: [], secrets,
    extension: { packageJSON: { version: VERSION } },
    globalState: { get: key => globals.get(key), update: async (key, value) => globals.set(key, value) },
  };
  extension.activate(context);
  assert.equal(commands.size, 20);
  assert.equal(telemetryLoggers, 1);
  assert.equal(secrets.writes.length, 0);
  assert.equal(globals.size, 0);
  for (const remoteName of ['ssh-remote', 'wsl', 'dev-container']) {
    stub.env.remoteName = remoteName;
    await commands.get('wechatAHP.connect')();
    assert.match(errors.at(-1), /Remote-SSH, WSL, dev containers and web are unsupported/);
  }
  stub.env.remoteName = undefined;
  await commands.get('wechatAHP.connect')();
  assert.match(errors.at(-1), /Select Existing Host/);
  await extension.deactivate();
  for (const external of externals) {
    assert.ok(external === '../dist/extension.cjs' || external === 'vscode'
      || builtinModules.includes(external) || external.startsWith('node:'), `Unexpected external dependency: ${external}`);
  }
  const bundle = await readFile(new URL('../dist/extension.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /C:\\\\code|TEST-ONLY-BOT|TEST-PRIVATE-CONTEXT|\.test-build|wechat-ahp-channel/);
  for (const mode of ['untrusted', 'virtual', 'empty']) {
    let html = '';
    let disposed = false;
    const calls = [];
    const originalFetch = globalThis.fetch;
    stub.workspace.workspaceFolders = mode === 'empty' ? undefined : [{ uri: {
      scheme: mode === 'virtual' ? 'vscode-vfs' : 'file',
      get fsPath() { throw new Error('QR login must not access workspace paths.'); },
    } }];
    stub.window.showWarningMessage = async () => 'Show QR';
    stub.window.showInformationMessage = async () => undefined;
    stub.window.createWebviewPanel = (_type, _title, _column, options) => {
      assert.equal(options.enableScripts, false);
      assert.deepEqual(options.localResourceRoots, []);
      return {
        webview: { set html(value) { html = value; } },
        onDidDispose: disposable, dispose() { disposed = true; },
      };
    };
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (new URL(url).pathname.endsWith('get_bot_qrcode')) {
        return new Response(JSON.stringify({ qrcode: 'fixture-qr-seed', qrcode_img_content: 'https://weixin.qq.com/fixture-qr' }));
      }
      assert.equal(new URL(url).pathname, '/ilink/bot/get_qrcode_status');
      return new Response(JSON.stringify({
        status: 'confirmed', bot_token: credentials.token, ilink_bot_id: credentials.botId, ilink_user_id: credentials.ownerId,
      }));
    };
    try {
      const before = telemetryLoggers;
      extension.activate(context);
      await commands.get('wechatAHP.login')();
      assert.equal(telemetryLoggers, before + 1);
      assert.equal(calls.length, 2);
      assert.equal(secrets.state().credentials.ownerId, credentials.ownerId);
      assert.equal(globals.size, 0);
      assert.equal(disposed, true);
      assert.match(html, /default-src 'none'/);
      assert.doesNotMatch(html, /TEST-ONLY|TEST-PRIVATE|fixture-qr-seed|<script|https:\/\/weixin/);
      const png = Buffer.from(html.match(/src="data:image\/png;base64,([^"]+)"/)[1], 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    } finally {
      await extension.deactivate();
      globalThis.fetch = originalFetch;
    }
  }
});
