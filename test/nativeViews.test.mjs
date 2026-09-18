import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindingKey, Vault, SECRET_KEY } from '../.test-build/core.mjs';
import { binding, credentials, fakeHost, fakeWeixin, message, MemorySecrets, waitFor, registryFixtureDirectories, registryEnvironment, mockOsForTests } from './helpers.mjs';
import { addNativeViewApi } from './vscodeMock.mjs';

test('manifest contributes two native English views and scoped actions without changing the fixed version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.contributes.views.wechatAHP.map(view => view.name), ['Sessions', 'Connection']);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, 'media/wechat-ahp.svg');
  for (const command of manifest.contributes.commands) assert.match(command.title, /^[\x20-\x7e]+$/);
  const menu = manifest.contributes.menus['view/item/context'];
  assert.ok(menu.some(item => item.command === 'wechatAHP.bindAndConnect' && item.when.includes('!wechatAHP.active')));
  assert.ok(menu.some(item => item.command === 'wechatAHP.loadMoreSessions' && item.when.includes('wechatHostMore')));
  assert.equal(manifest.contributes.commands.some(command => /cancelTurn|disposeSession|approveTool|retryAll/.test(command.command)), false);
  const icon = await readFile(new URL('../media/wechat-ahp.svg', import.meta.url), 'utf8');
  assert.match(icon, /<svg/);
  assert.doesNotMatch(icon, /script|href=/);
});

test('native views reuse scoped controller actions, stay read-only while browsing, and reflect live health without secrets', async t => {
  const host = await fakeHost(t);
  const weixin = await fakeWeixin(t, [{ ret: 0, msgs: [message('ui', 'PRIVATE-INBOUND-BODY')], get_updates_buf: 'ui-cursor' }]);
  const root = resolve('.test-build', `native-ui-${randomUUID()}`);
  const dirs = registryFixtureDirectories(root);
  for (const path of dirs) await mkdir(path, { mode: 0o700 });
  const registry = join(dirs.at(-1), 'host.json');
  await writeFile(registry, JSON.stringify({
    schemaVersion: 2, type: 'editor', pid: process.pid, instanceId: 'ui-fixture', protocolVersion: '0.9.0',
    connectionToken: host.target.connectionToken, endpoint: host.target.endpoint,
  }), { mode: 0o600 });
  const restoreEnvironment = registryEnvironment(root);
  const originalFetch = globalThis.fetch;
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const originalLoad = Module._load;
  const commands = new Map();
  const logs = [];
  const errors = [];
  const information = [];
  const globals = new Map();
  const secrets = new MemorySecrets();
  await Vault.create(secrets, credentials);
  let permitConnect = false;
  let pickCalls = 0;
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
      createOutputChannel: () => ({ ...dispose(), appendLine: text => logs.push(text), show() {} }),
      createStatusBarItem: () => ({ ...dispose(), show() {} }),
      showQuickPick: async () => { pickCalls++; return undefined; },
      showWarningMessage: async text => text.startsWith('Bind ') ? 'Save Binding' : permitConnect ? 'Connect' : undefined,
      showErrorMessage: async text => errors.push(text),
      showInformationMessage: async text => information.push(text),
    },
    commands: { registerCommand: (id, work) => { commands.set(id, work); return dispose(); } },
  };
  const { views, contexts, clipboard } = addNativeViewApi(stub);
  const subscriptions = [];
  let extension;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).origin !== credentials.base) return originalFetch(url, options);
    const body = JSON.parse(options.body);
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith('/getupdates')) {
      const update = await weixin.api.updates(body.get_updates_buf, options.signal);
      return new Response(JSON.stringify({ ret: 0, msgs: update.msgs, get_updates_buf: update.cursor }));
    }
    if (endpoint.endsWith('/sendmessage')) {
      await weixin.api.send(body.msg, options.signal);
      return new Response('{}');
    }
    throw new Error('Unexpected non-fixture API operation');
  };
  try {
    Module._load = function (request, parent, isMain) {
      if (request === 'vscode') return stub;
      if (request === 'node:os') return mockOsForTests(originalLoad.call(this, request, parent, isMain), root);
      return originalLoad.call(this, request, parent, isMain);
    };
    extension = require('../dist/extension.cjs');
    Module._load = originalLoad;
    extension.activate({
      subscriptions, secrets, extension: { packageJSON: { version: '0.1.0' } },
      globalState: { get: key => globals.get(key), update: async (key, value) => globals.set(key, value) },
    });
    assert.equal(views.size, 2);
    await waitFor(() => contexts.get('wechatAHP.signedIn') === true);
    assert.equal(host.methods.length, 0, 'activation must not connect any Host');
    const sessionsView = views.get('wechatAHP.sessions');
    const connectionView = views.get('wechatAHP.connection');
    const sessions = sessionsView.options.treeDataProvider;
    const connection = connectionView.options.treeDataProvider;
    const [hostNode] = await sessions.getChildren();
    assert.equal(host.methods.length, 0, 'root discovery is registry-only');
    const [sessionNode] = await sessions.getChildren(hostNode);
    const [chatNode] = await sessions.getChildren(sessionNode);
    for (const item of [hostNode, sessionNode, chatNode]) assert.equal(sessions.getTreeItem(item).command, undefined);
    assert.equal(sessions.getTreeItem(chatNode).contextValue, 'wechatChat');
    assert.equal(host.actions.length, 0);
    await commands.get('wechatAHP.nodeDetails')(chatNode);
    assert.equal(pickCalls, 1);
    await commands.get('wechatAHP.copyResource')(chatNode);
    assert.equal(clipboard.at(-1), binding.chat);
    await commands.get('wechatAHP.pingHost')(hostNode);
    assert.ok(information.some(text => text.includes('AHP ping')));
    await commands.get('wechatAHP.bindChat')(chatNode);
    assert.equal(pickCalls, 1, 'tree binding must not rerun the selection wizard');
    assert.equal(globals.get('wechat-ahp.binding.v1').chat, binding.chat);
    assert.equal(contexts.get('wechatAHP.bound'), true);
    assert.equal(host.actions.length, 0, 'binding alone must not register the client');
    assert.equal(sessions.getTreeItem(chatNode).contextValue, 'wechatChatBound');
    await commands.get('wechatAHP.revealBinding')();
    assert.equal(sessionsView.revealed.node.id, chatNode.id);
    await commands.get('wechatAHP.bindAndConnect')(chatNode);
    assert.equal(host.actions.length, 0, 'cancelled consent must not connect');
    permitConnect = true;
    await commands.get('wechatAHP.connect')();
    await waitFor(() => host.actions.some(item => item.action.type === 'chat/turnStarted'));
    const current = () => connection.getChildren();
    assert.equal(contexts.get('wechatAHP.active'), true);
    assert.equal(current().find(row => row.id === 'receive').value, 'Polling');
    assert.equal(current().find(row => row.id === 'agent').value, 'Busy');
    const pending = host.tool({ confirmed: null });
    const secondPending = host.tool({ confirmed: null });
    await waitFor(() => current().find(row => row.id === 'agent').value === 'Awaiting input');
    host.emit({ type: 'chat/toolCallConfirmed', turnId: pending.turn, toolCallId: pending.toolCallId, approved: true, confirmed: 'user-action' });
    await waitFor(() => host.state.activeTurn.responseParts.filter(part => part.kind === 'toolCall' && part.toolCall.status === 'pending-confirmation').length === 1);
    assert.equal(current().find(row => row.id === 'agent').value, 'Awaiting input');
    host.emit({ type: 'chat/toolCallConfirmed', turnId: secondPending.turn, toolCallId: secondPending.toolCallId, approved: true, confirmed: 'user-action' });
    await waitFor(() => current().find(row => row.id === 'agent').value === 'Busy');
    host.answer('PRIVATE-ASSISTANT-BODY');
    await waitFor(() => weixin.sends.length === 1);
    await waitFor(() => current().find(row => row.id === 'agent').value === 'Idle');
    sessionsView.setVisible(false); connectionView.setVisible(false);
    assert.equal(contexts.get('wechatAHP.active'), true, 'hiding views must not stop sync');
    await commands.get('wechatAHP.copyDiagnostics')();
    const safe = JSON.stringify({ rows: current(), tree: [hostNode, sessionNode, chatNode], diagnostics: clipboard.at(-1) });
    for (const value of [credentials.token, credentials.ownerId, host.target.connectionToken, 'TEST-PRIVATE-CONTEXT-ui', 'PRIVATE-INBOUND-BODY', 'PRIVATE-ASSISTANT-BODY']) {
      assert.ok(!safe.includes(value), `Private value leaked into UI: ${value}`);
    }
    assert.match(current().find(row => row.id === 'recent').children[0].value, /API accepted/);
    assert.equal(bindingKey(globals.get('wechat-ahp.binding.v1')), secrets.state().peer.binding);
    await commands.get('wechatAHP.disconnect')();
    assert.equal(contexts.get('wechatAHP.active'), false);
    assert.equal(current().find(row => row.id === 'ahp').value, 'Disconnected');
    assert.equal(host.actions.some(item => item.action.type === 'chat/turnCancelled'), false);
    assert.deepEqual(errors, []);
    await commands.get('wechatAHP.refreshSessions')();
    await commands.get('wechatAHP.bindChat')({ ...chatNode, id: 'forged-node-id' });
    assert.match(errors.at(-1), /no longer in the catalog/);
    assert.equal(secrets.data.has(SECRET_KEY), true);
  } finally {
    Module._load = originalLoad;
    await extension?.deactivate();
    for (const subscription of subscriptions) subscription.dispose();
    globalThis.fetch = originalFetch;
    restoreEnvironment();
    await unlink(registry);
    for (const directory of dirs.reverse()) await rmdir(directory);
  }
});
