import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol';
import { Bridge, ChannelRuntime, HostConnection, Inbox, pause } from '../.test-build/core.mjs';
import { binding, fakeHost, fakeWeixin, message, signal, vault, waitFor } from './helpers.mjs';

async function open(t, options = {}) {
  const host = await fakeHost(t, options);
  const fake = await fakeWeixin(t, [], {});
  const { secrets, vault: store } = await vault();
  const logs = [];
  const connection = await HostConnection.connect(host.target, signal(), randomUUID(), 500);
  const inbox = new Inbox(store, binding, fake.api, text => logs.push(text));
  const bridge = await Bridge.open(connection, binding, inbox, signal(), text => logs.push(text));
  t.after(async () => { await bridge.close(); await connection.close(); });
  return { host, fake, store, secrets, connection, inbox, bridge, logs };
}

for (const pipe of [false, true]) {
  test(`raw WeChat text -> SAME chat -> automatic completed answer over ${pipe ? 'native IPC' : 'TCP'}`, async t => {
    const { host, fake, store, connection, inbox, bridge } = await open(t, { pipe });
    assert.equal((await connection.listSessions(signal()))[0].resource, binding.session);
    const init = host.methods.find(item => item.method === 'initialize');
    assert.deepEqual(init.params.protocolVersions, [...SUPPORTED_PROTOCOL_VERSIONS]);
    assert.deepEqual(init.params.initialSubscriptions, ['ahp-root://']);
    const original = 'HI  \n"\u{1F43C}"';
    await inbox.accept({ msgs: [message('raw', original)] }, signal());
    await bridge.deliverPending(signal());
    const started = host.actions.find(item => item.action.type === 'chat/turnStarted');
    assert.equal(started.channel, binding.chat);
    assert.equal(started.action.message.text, original);
    assert.match(host.state.turns[0].message.text, /BLUE-PANDA/);
    assert.equal(fake.sends.length, 0, 'inbound text must not echo to WeChat');
    const turn = host.state.activeTurn.id;
    const id = randomUUID();
    host.emit({ type: 'chat/responsePart', turnId: turn, part: { kind: 'markdown', id, content: 'Hello' } });
    host.emit({ type: 'chat/delta', turnId: turn, partId: id, content: ' from the same chat' });
    await sleep(30);
    assert.equal(fake.sends.length, 0, 'do not send streaming fragments');
    host.completeTurn();
    await waitFor(() => store.snapshot().outbox.some(entry => entry.status === 'sent'));
    assert.equal(fake.sends.length, 1);
    assert.equal(fake.sends[0].item_list[0].text_item.text, 'Hello from the same chat');
    assert.equal(fake.sends[0].context_token, 'TEST-PRIVATE-CONTEXT-raw');
    assert.deepEqual(host.actions.find(item => item.action.type === 'session/activeClientSet').action.activeClient.tools, []);
    assert.equal(host.actions.some(item => item.action.type.startsWith('chat/toolCall')), false);
    assert.equal(host.methods.some(item => /createSession|createChat/.test(item.method)), false);
    assert.doesNotMatch(JSON.stringify(host.actions), /TEST-PRIVATE-CONTEXT|TEST-ONLY-BOT/);
  });
}

test('new VS Code user text and final assistant text automatically sync to the same authorized WeChat peer', async t => {
  const { host, fake, inbox, bridge, store } = await open(t);
  await inbox.accept({ msgs: [message()] }, signal());
  await bridge.deliverPending(signal());
  host.answer('WeChat answer');
  await waitFor(() => store.snapshot().outbox.some(entry => entry.status === 'sent'));
  host.startEditorTurn('hello from vscode');
  await waitFor(() => fake.sends.length === 2);
  host.answer('Hello from VS Code');
  await waitFor(() => fake.sends.length === 3);
  assert.deepEqual(fake.sends.map(msg => msg.item_list[0].text_item.text), ['WeChat answer', '[VS Code User]\nhello from vscode', 'Hello from VS Code']);
  assert.ok(fake.sends.every(msg => msg.context_token === 'TEST-PRIVATE-CONTEXT-1'));
  assert.equal(host.actions.filter(item => item.action.type === 'chat/turnStarted').length, 1, 'editor sync must not create a second turn');
});

test('no peer context waits durably, then authorized inbound text wakes pending outbound sends', async t => {
  const { host, fake, inbox, bridge, store } = await open(t);
  host.startEditorTurn('before first WeChat message');
  host.answer('waiting answer');
  await waitFor(() => store.snapshot().outbox.length === 2);
  assert.ok(store.snapshot().outbox.every(entry => entry.status === 'waiting'));
  assert.equal(fake.sends.length, 0);
  await inbox.accept({ msgs: [message('stranger', 'no', { from_user_id: 'unauthorized' })] }, signal());
  await bridge.deliverPending(signal());
  assert.equal(fake.sends.length, 0);
  await inbox.accept({ msgs: [message('owner')] }, signal());
  await bridge.deliverPending(signal());
  await waitFor(() => fake.sends.length === 2);
  assert.deepEqual(fake.sends.map(msg => msg.item_list[0].text_item.text), ['[VS Code User]\nbefore first WeChat message', 'waiting answer']);
  assert.ok(fake.sends.every(msg => msg.context_token === 'TEST-PRIVATE-CONTEXT-owner'));
});

test('busy chat queues unmodified WeChat text and never cancels another client turn', async t => {
  const { host, fake, inbox, bridge } = await open(t, { busy: true });
  const existingTurn = host.state.activeTurn.id;
  await inbox.accept({ msgs: [message('queued', 'HI')] }, signal());
  await bridge.deliverPending(signal());
  const queued = host.actions.find(item => item.action.type === 'chat/pendingMessageSet');
  assert.equal(queued.action.message.text, 'HI');
  assert.equal(queued.action.kind, 'queued');
  assert.equal(host.state.activeTurn.id, existingTurn);
  host.answer('old active turn is not mirrored');
  await sleep(20);
  assert.equal(fake.sends.length, 0);
  host.dequeue();
  host.answer('new WeChat reply');
  await waitFor(() => fake.sends.length === 1);
  assert.equal(fake.sends[0].context_token, 'TEST-PRIVATE-CONTEXT-queued');
  await bridge.close();
  assert.equal(host.actions.some(item => item.action.type === 'chat/turnCancelled'), false);
});

test('editor queued input mirrors only once when enqueued and does not echo again when started', async t => {
  const { host, fake, inbox, bridge } = await open(t, { busy: true });
  await inbox.accept({ msgs: [message('context')] }, signal());
  const queueId = randomUUID();
  host.emit({
    type: 'chat/pendingMessageSet', kind: 'queued', id: queueId,
    message: { origin: { kind: 'user' }, text: 'queued from editor' },
  });
  await waitFor(() => fake.sends.length === 1);
  host.completeTurn();
  host.dequeue();
  host.answer('queued answer');
  await waitFor(() => fake.sends.length === 2);
  assert.deepEqual(fake.sends.map(msg => msg.item_list[0].text_item.text), ['[VS Code User]\nqueued from editor', 'queued answer']);
  await bridge.close();
});

test('editor steering text is mirrored once without creating a second assistant response', async t => {
  const { host, fake, inbox } = await open(t);
  await inbox.accept({ msgs: [message('context')] }, signal());
  host.startEditorTurn('editor start');
  await waitFor(() => fake.sends.length === 1);
  const steering = host.emit({
    type: 'chat/pendingMessageSet', kind: 'steering', id: randomUUID(),
    message: { origin: { kind: 'user' }, text: 'steer with original text' },
  });
  host.repeat(steering);
  await waitFor(() => fake.sends.length === 2);
  host.answer('single final answer');
  await waitFor(() => fake.sends.length === 3);
  assert.deepEqual(fake.sends.map(item => item.item_list[0].text_item.text), ['[VS Code User]\neditor start', '[VS Code User]\nsteer with original text', 'single final answer']);
});

test('reasoning, tool inputs/results, other channels, history, drafts and cancelled output are never copied', async t => {
  const { host, fake, inbox, bridge, store } = await open(t);
  assert.equal(fake.sends.length, 0, 'initial history must not be mirrored');
  await inbox.accept({ msgs: [message()] }, signal());
  await bridge.deliverPending(signal());
  const turnId = host.state.activeTurn.id;
  host.tool({ text: 'PRIVATE-TOOL-INPUT' });
  host.emit({ type: 'chat/responsePart', turnId, part: { kind: 'reasoning', id: 'r', content: 'PRIVATE-REASONING' } });
  host.emit({ type: 'chat/reasoning', turnId, partId: 'r', content: 'MORE-REASONING' });
  host.emit({ type: 'chat/responsePart', turnId, part: { kind: 'contentRef', uri: 'file:///PRIVATE' } });
  host.emit({ type: 'chat/draftChanged', message: { text: 'PRIVATE-DRAFT', origin: { kind: 'user' } } });
  host.emit({ type: 'chat/turnStarted', turnId: randomUUID(), message: { text: 'OTHER-CHAT', origin: { kind: 'user' } } }, 'ahp-chat:/other');
  host.answer('Only visible completed text');
  await waitFor(() => store.snapshot().outbox.some(entry => entry.status === 'sent'));
  assert.deepEqual(fake.sends.map(msg => msg.item_list[0].text_item.text), ['Only visible completed text']);
  assert.equal(host.actions.some(item => item.action.type.startsWith('chat/toolCall')), false);
  assert.equal(host.methods.some(item => item.method === 'resourceRead'), false);
  await inbox.accept({ msgs: [message('cancel')] }, signal());
  await bridge.deliverPending(signal());
  host.emit({ type: 'chat/responsePart', turnId: host.state.activeTurn.id, part: { kind: 'markdown', id: 'partial', content: 'Cancelled partial' } });
  host.emit({ type: 'chat/turnCancelled', turnId: host.state.activeTurn.id, duration: 1 });
  await sleep(30);
  assert.equal(fake.sends.length, 1);
});

test('duplicate notifications and replayed completion do not duplicate outbound text', async t => {
  const { host, fake, inbox, bridge, store } = await open(t);
  await inbox.accept({ msgs: [message(), message()] }, signal());
  await bridge.deliverPending(signal());
  const start = host.envelopes.find(item => item.action.type === 'chat/turnStarted');
  host.repeat(start);
  host.answer('one answer');
  const complete = host.envelopes.at(-1);
  host.repeat(complete);
  host.repeat({ ...complete, serverSeq: 0 });
  await waitFor(() => store.snapshot().outbox.some(entry => entry.status === 'sent'));
  await sleep(20);
  assert.equal(fake.sends.length, 1);
});

test('each WeChat-originated answer keeps its own context while editor turns use the latest context', async t => {
  const { host, fake, inbox, bridge } = await open(t);
  await inbox.accept({ msgs: [message('first')] }, signal());
  await bridge.deliverPending(signal());
  await inbox.accept({ msgs: [message('second')] }, signal());
  await bridge.deliverPending(signal());
  host.answer('first answer');
  await waitFor(() => fake.sends.length === 1);
  host.dequeue();
  host.answer('second answer');
  await waitFor(() => fake.sends.length === 2);
  host.startEditorTurn('editor user');
  host.answer('editor answer');
  await waitFor(() => fake.sends.length === 4);
  assert.deepEqual(fake.sends.map(msg => msg.context_token), [
    'TEST-PRIVATE-CONTEXT-first', 'TEST-PRIVATE-CONTEXT-second', 'TEST-PRIVATE-CONTEXT-second', 'TEST-PRIVATE-CONTEXT-second',
  ]);
});

test('AHP acknowledgement loss reconciles snapshot without creating another turn', async t => {
  const { host, inbox, bridge, connection, store } = await open(t);
  host.ignoreAck = 'chat/turnStarted';
  await inbox.accept({ msgs: [message()] }, signal());
  await assert.rejects(bridge.deliverPending(signal()), /timed out/);
  assert.equal(store.snapshot().messages[0].delivery, 'dispatching');
  await bridge.close();
  host.ignoreAck = undefined;
  const restored = await Bridge.open(connection, binding, inbox, signal(), () => {});
  t.after(() => restored.close());
  await restored.deliverPending(signal());
  assert.equal(store.snapshot().messages[0].delivery, 'accepted');
  assert.equal(host.actions.filter(item => item.action.type === 'chat/turnStarted').length, 1);
});

test('unprovable dispatch stays ambiguous and is not blindly retried', async t => {
  const { host, inbox, bridge, store, connection } = await open(t);
  host.reject = 'chat/turnStarted';
  await inbox.accept({ msgs: [message()] }, signal());
  await assert.rejects(bridge.deliverPending(signal()), /rejected/);
  await bridge.close();
  host.reject = undefined;
  await assert.rejects(Bridge.open(connection, binding, inbox, signal(), () => {}), /ambiguous/);
  assert.equal(store.snapshot().messages[0].delivery, 'ambiguous');
});

test('runtime reconnect recovers tracked response without mirroring old history or cancelling host turns', async t => {
  const host = await fakeHost(t);
  const fake = await fakeWeixin(t, [{ ret: 0, msgs: [message()], get_updates_buf: 'durable-cursor' }]);
  const { vault: store } = await vault();
  const phases = [];
  const errors = [];
  let resolutions = 0;
  const runtime = new ChannelRuntime({
    binding, vault: store, api: fake.api,
    resolveHost: async () => { resolutions++; return host.target; }, assertAllowed() {}, assertScope: async () => {},
    log() {}, status: phase => phases.push(phase), failed: text => errors.push(text),
    wait: (ms, abort) => pause(Math.min(ms, 20), abort), ackTimeout: 500,
  });
  t.after(() => runtime.stop());
  assert.equal(runtime.start(), runtime.start());
  await runtime.start();
  // Local tracking is write-ahead; it does not prove the Host has accepted the turn.
  await waitFor(() => {
    const state = store.snapshot();
    return state.sync?.turns.length === 1
      && state.messages[0]?.delivery === 'accepted'
      && host.state.activeTurn !== undefined
      && host.state.activeTurn.id === state.messages[0].turnId;
  });
  host.disconnect();
  host.answer('answer completed during reconnect');
  await waitFor(() => resolutions >= 2 && phases.filter(item => item === 'Connected').length >= 2);
  await waitFor(() => fake.sends.length === 1);
  assert.equal(fake.sends[0].item_list[0].text_item.text, 'answer completed during reconnect');
  assert.ok(fake.polls.some(item => item.get_updates_buf === 'durable-cursor'));
  await runtime.stop();
  await runtime.stop();
  assert.equal(host.actions.some(item => item.action.type === 'chat/turnCancelled'), false);
  assert.ok(host.actions.some(item => item.action.type === 'session/activeClientRemoved'));
  assert.deepEqual(errors, []);
});

test('disconnect invalidates future sends but leaves original Host turns untouched', async t => {
  const { host, fake, inbox, bridge } = await open(t);
  await inbox.accept({ msgs: [message()] }, signal());
  await bridge.deliverPending(signal());
  await bridge.close();
  host.answer('after disconnect');
  await sleep(30);
  assert.equal(fake.sends.length, 0);
  assert.equal(host.actions.some(item => item.action.type === 'chat/turnCancelled'), false);
});

test('scope changes and known credentials stop mirroring rather than sending sensitive text', async t => {
  const env = await open(t);
  await env.inbox.accept({ msgs: [message()] }, signal());
  await env.bridge.deliverPending(signal());
  env.host.answer('TEST-ONLY-AHP-TOKEN');
  assert.match((await env.bridge.failure).message, /credential/);
  assert.equal(env.fake.sends.length, 0);
  const other = await open(t);
  other.host.emit({ type: 'session/workingDirectorySet', workingDirectory: 'file:///untrusted' }, binding.session);
  assert.match((await other.bridge.failure).message, /scope changed/);
  assert.equal(other.host.actions.some(item => item.action.type === 'chat/toolCallConfirmed'), false);
});

test('unknown protocol and missing/mismatched snapshots are explicit failures', async t => {
  const host = await fakeHost(t, { protocolVersion: '99.0.0' });
  await assert.rejects(HostConnection.connect(host.target, signal()), /unsupported/);
  const missing = await fakeHost(t, { missingSnapshot: true });
  const connection = await HostConnection.connect(missing.target, signal());
  t.after(() => connection.close());
  await assert.rejects(connection.session(binding.session, signal()), /snapshot/);
  const env = await open(t);
  await assert.rejects(Bridge.open(env.connection, { ...binding, chat: 'ahp-chat:/missing' }, env.inbox, signal(), () => {}), /missing/);
});
