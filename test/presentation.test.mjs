import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Inbox, TextSync, presentMessage, privateSummary, bindingKey, initialChannelState, sendStatus } from '../.test-build/core.mjs';
import { binding, chatState, credentials, message, signal, vault } from './helpers.mjs';

test('only editor user text gets an English source label, preserving original whitespace and assistant text', () => {
  const text = '  Hello\n"\u{1F43C}"\n';
  assert.deepEqual(presentMessage('user', text), [`[VS Code User]\n${text}`]);
  assert.deepEqual(presentMessage('assistant', text), [text]);
});

test('every long user segment is numbered, bounded in UTF-8 bytes and losslessly reconstructable', () => {
  const text = '\u{1F43C}'.repeat(4096);
  const parts = presentMessage('user', text);
  assert.ok(parts.length > 1 && parts.length <= 16);
  assert.ok(parts.every((part, index) => part.startsWith(`[VS Code User ${index + 1}/${parts.length}]\n`)
    && Buffer.byteLength(part) <= 3500 && part.isWellFormed()));
  assert.equal(parts.map(part => part.slice(part.indexOf('\n') + 1)).join(''), text);
  assert.equal(presentMessage('assistant', text).join(''), text);
  assert.throws(() => presentMessage('user', text + 'x'), /16 KiB/);
});

test('formatted segments are durable before the first send and cleared after acceptance', async () => {
  const { secrets, vault: store } = await vault();
  const sent = [];
  const api = { send: async msg => {
    const record = secrets.state().outbox[0];
    assert.equal(record.status, 'sending');
    assert.ok(record.parts.includes(msg.item_list[0].text_item.text));
    sent.push(msg.item_list[0].text_item.text);
  } };
  const inbox = new Inbox(store, binding, api, () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  const sync = new TextSync(inbox, randomUUID(), () => {}, () => false);
  await sync.open(chatState());
  await sync.started(randomUUID(), { text: 'editor original', origin: { kind: 'user' } });
  await sync.flush(signal());
  assert.deepEqual(sent, ['[VS Code User]\neditor original']);
  assert.equal(store.snapshot().outbox[0].parts, undefined);
  assert.equal(store.snapshot().outbox[0].text, '');
});

test('UI state projects metadata only, uses the exact binding, and does not call API acceptance a read receipt', async () => {
  const { vault: store } = await vault();
  const inbox = new Inbox(store, binding, { send: async () => {} }, () => {});
  await inbox.accept({ msgs: [message('private', 'PRIVATE-USER-TEXT')] }, signal());
  const sync = new TextSync(inbox, randomUUID(), () => {}, () => false);
  await sync.open(chatState());
  await sync.started(randomUUID(), { text: 'PRIVATE-EDITOR-TEXT', origin: { kind: 'user' } });
  await sync.flush(signal());
  const summary = privateSummary(store.snapshot(), binding);
  assert.equal(summary.account, 'Signed in');
  assert.equal(summary.peerReady, true);
  assert.ok(summary.recent.some(entry => entry.status === 'API accepted (not a read receipt)'));
  const serialized = JSON.stringify(summary);
  for (const secret of [credentials.token, credentials.ownerId, 'TEST-PRIVATE-CONTEXT-private', 'PRIVATE-USER-TEXT', 'PRIVATE-EDITOR-TEXT']) {
    assert.ok(!serialized.includes(secret));
  }
  assert.equal(privateSummary(store.snapshot(), { ...binding, chat: 'ahp-chat:/different' }).recent.length, 0);
  assert.equal(bindingKey(binding), store.snapshot().peer.binding);
  assert.equal(sendStatus({ ...initialChannelState(), active: true }), 'Waiting for a WeChat message');
  assert.equal(sendStatus({ ...initialChannelState(), uncertain: 1 }), 'Uncertain delivery (1)');
});
