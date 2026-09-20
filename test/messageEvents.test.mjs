import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  Bridge, ChannelRuntime, HostConnection, Inbox, MessageEvents, SafeError, TextSync, Telemetry,
  Vault, WAITING_NOTICE, bindingKey, closingResults, hash, pause, SECRET_KEY,
} from '../.test-build/core.mjs';
import { binding, chatState, credentials, fakeHost, message, signal, vault, waitFor } from './helpers.mjs';
import { fakeTelemetry } from './telemetryHelpers.mjs';

const user = text => ({ origin: { kind: 'user' }, text });
const turn = (id, text = 'PRIVATE-ANSWER') => ({
  id, state: 'complete', message: user('PRIVATE-PROMPT'),
  responseParts: [{ kind: 'markdown', id: 'part', content: text }],
});
function observer() {
  const events = [];
  const hooks = {
    input: source => events.push({ type: 'input', source }),
    completed: hasReply => events.push({ type: 'completed', hasReply }),
    result: (source, outcome, error) => events.push({
      type: 'result', source, outcome, ...(error ? { error_category: error instanceof SafeError ? error.kind : 'unexpected' } : {}),
    }),
  };
  return { events, hooks, tracker: new MessageEvents(hooks) };
}
async function setup({ context = true, send } = {}) {
  const { secrets, vault: store } = await vault();
  const captured = observer();
  const sends = [];
  const logs = [];
  const api = { send: async (message, signal) => { sends.push(message); if (send) await send(message, signal, sends.length); } };
  const inbox = new Inbox(store, binding, api, text => logs.push(text), captured.tracker);
  if (context) await store.update(next => { next.peer = { binding: inbox.key, contextToken: 'PRIVATE-CONTEXT' }; });
  const run = randomUUID();
  const sync = new TextSync(inbox, run, text => logs.push(text), () => false);
  await sync.open(chatState());
  return { ...captured, secrets, store, sends, logs, api, inbox, run, sync };
}
const results = events => events.filter(event => event.type === 'result');

test('owner inputs, echoed actions, queued/dequeued editor prompts, steering and completed turns count once', async t => {
  const host = await fakeHost(t);
  const s = await setup();
  const connection = await HostConnection.connect(host.target, signal(), s.run, 300);
  const bridge = await Bridge.open(connection, binding, s.inbox, signal(), () => {});
  t.after(async () => { await bridge.close(); await connection.close(); });
  await s.inbox.accept({ msgs: [
    message('owner', 'PRIVATE-OWNER-PROMPT'), message('owner', 'duplicate'),
    message('stranger', 'PRIVATE-STRANGER', { from_user_id: 'stranger' }),
  ] }, signal());
  await bridge.deliverPending(signal());
  assert.deepEqual(s.events, [
    { type: 'input', source: 'wechatUser' }, { type: 'result', source: 'wechatUser', outcome: 'host_accepted' },
  ]);
  const queuedId = randomUUID();
  const queued = host.emit({ type: 'chat/pendingMessageSet', kind: 'queued', id: queuedId, message: user('PRIVATE-EDITOR') });
  host.repeat(queued);
  await waitFor(() => s.sends.length === 1);
  host.answer('PRIVATE-ANSWER');
  await waitFor(() => results(s.events).some(e => e.source === 'agentReply'));
  host.dequeue();
  await waitFor(() => host.state.activeTurn);
  const steering = host.emit({ type: 'chat/pendingMessageSet', kind: 'steering', id: randomUUID(), message: user('PRIVATE-STEER') });
  host.repeat(steering);
  host.answer('PRIVATE-SECOND-ANSWER');
  const completed = host.envelopes.at(-1);
  host.repeat(completed);
  await waitFor(() => results(s.events).filter(e => e.source === 'agentReply').length === 2);
  assert.equal(s.events.filter(e => e.type === 'input' && e.source === 'vscodeUser').length, 2);
  assert.equal(s.events.filter(e => e.type === 'completed').length, 2);
  assert.equal(results(s.events).filter(e => e.source === 'vscodeUser' && e.outcome === 'api_accepted').length, 2);
  assert.doesNotMatch(JSON.stringify(s.events), /PRIVATE|ahp-|test-owner|context/);
});

test('completion precedes delivery, streaming is not counted, no-text and cancelled turns have no reply result', async () => {
  const s = await setup({ context: false });
  const id = randomUUID();
  await s.sync.started(id, user('PRIVATE'));
  assert.deepEqual(s.events, [{ type: 'input', source: 'vscodeUser' }]);
  await s.sync.complete(turn(id));
  await s.sync.complete(turn(id));
  assert.deepEqual(s.events.at(-1), { type: 'completed', hasReply: true });
  assert.equal(results(s.events).length, 0, 'waiting for context is not a result');
  await s.inbox.accept({ msgs: [message()] }, signal());
  await s.sync.flush(signal());
  assert.deepEqual(results(s.events).map(e => [e.source, e.outcome]), [
    ['vscodeUser', 'api_accepted'], ['agentReply', 'api_accepted'],
  ]);
  const emptyId = randomUUID();
  await s.sync.started(emptyId, user('empty answer input'));
  await s.sync.complete(turn(emptyId, ' \n'));
  assert.deepEqual(s.events.at(-1), { type: 'completed', hasReply: false });
  const cancelled = randomUUID();
  await s.sync.started(cancelled, user('cancelled'));
  await s.sync.cancel(cancelled);
  const before = s.events.length;
  await s.sync.complete(turn(cancelled, 'MUST NOT BE COUNTED'));
  assert.equal(s.events.length, before);
});

test('completion remains visible when outbound text is blocked before delivery', async () => {
  const s = await setup();
  const id = randomUUID();
  await s.sync.started(id, user('input'));
  await assert.rejects(s.sync.complete(turn(id, credentials.token)), /credential/);
  assert.deepEqual(s.events.slice(-2), [
    { type: 'completed', hasReply: true },
    { type: 'result', source: 'agentReply', outcome: 'failed', error_category: 'local' },
  ]);
  assert.equal(s.sends.length, 0);
});

test('multipart sends emit one logical result and partial/aborted sends remain uncertain without retry', async () => {
  for (const fail of [false, true]) {
    const s = await setup({ send: async (_message, _signal, index) => {
      if (fail && index === 2) throw new SafeError('PRIVATE-NETWORK', true, 'network');
    } });
    await s.sync.started(randomUUID(), user('a'.repeat(7500)));
    if (fail) await assert.rejects(s.sync.flush(signal()), /Do not resend/);
    else await s.sync.flush(signal());
    assert.deepEqual(results(s.events).map(e => e.outcome), [fail ? 'uncertain' : 'api_accepted']);
    assert.equal(s.sends.length, fail ? 2 : 3);
    await s.sync.flush(signal());
    assert.equal(s.sends.length, fail ? 2 : 3);
  }
  const cancel = new AbortController();
  const s = await setup({ send: async () => { cancel.abort(); throw new Error('PRIVATE-ABORT'); } });
  await s.sync.started(randomUUID(), user('cancel'));
  await assert.rejects(s.sync.flush(cancel.signal));
  assert.equal(results(s.events)[0].outcome, 'uncertain');
});

test('pre-send storage failure is failed; post-acceptance storage failure is uncertain, never accepted', async () => {
  for (const after of [false, true]) {
    const s = await setup({ send: async () => { s.secrets.fail = true; } });
    await s.sync.started(randomUUID(), user('PRIVATE'));
    if (!after) s.secrets.fail = true;
    await assert.rejects(s.sync.flush(signal()), /SecretStorage/);
    assert.deepEqual(results(s.events).map(e => [e.outcome, e.error_category]), [[after ? 'uncertain' : 'failed', 'storage']]);
    assert.equal(s.sends.length, after ? 1 : 0);
  }
});

test('Host acceptance is counted even if a fast turn already closed the inbound route', async () => {
  const s = await setup();
  await s.inbox.accept({ msgs: [message()] }, signal());
  const id = s.store.snapshot().messages[0].id;
  await s.inbox.markDispatching(id, randomUUID(), undefined);
  await s.store.update(next => { next.messages[0].delivery = 'closed'; });
  await s.inbox.accepted(id);
  await s.inbox.accepted(id);
  assert.deepEqual(results(s.events), [{ type: 'result', source: 'wechatUser', outcome: 'host_accepted' }]);
});

test('unprovable inbound recovery reports one uncertain result without a fabricated retry or success', async () => {
  const s = await setup();
  await s.inbox.accept({ msgs: [message()] }, signal());
  const id = s.store.snapshot().messages[0].id;
  await s.inbox.markDispatching(id, randomUUID(), undefined);
  await assert.rejects(s.inbox.recover(chatState()), /ambiguous/);
  await assert.rejects(s.inbox.recover(chatState()), /ambiguous/);
  s.tracker.results(await s.store.invalidateReplies(s.inbox.key));
  assert.deepEqual(results(s.events), [{ type: 'result', source: 'wechatUser', outcome: 'uncertain' }]);
  assert.equal(s.sends.length, 0);
});

test('automatic reconciliation reports Host acceptance, not an intermediate timeout result', async t => {
  const host = await fakeHost(t);
  host.ignoreAck = 'chat/turnStarted';
  const { vault: store } = await vault();
  const o = observer();
  let first = true;
  const runtime = new ChannelRuntime({
    binding, vault: store, resolveHost: async () => host.target,
    api: { updates: async (_cursor, signal) => {
      if (first) { first = false; return { msgs: [message()] }; }
      await pause(10000, signal); return { msgs: [] };
    } },
    assertAllowed() {}, assertScope: async () => {}, log() {}, status() {}, failed() {},
    messages: o.hooks, ackTimeout: 40, wait: (_ms, signal) => pause(1, signal),
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await waitFor(() => results(o.events).length === 1);
  assert.deepEqual(results(o.events), [{ type: 'result', source: 'wechatUser', outcome: 'host_accepted' }]);
  assert.equal(host.actions.filter(action => action.action.type === 'chat/turnStarted').length, 1);
  await runtime.stop();
  assert.equal(results(o.events).length, 1);
});

test('waiting notice is English, once per episode, deferred without context, excluded from telemetry and cancelled if stale', async () => {
  const s = await setup({ context: false });
  const id = randomUUID();
  await s.sync.setActivity(true, id);
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 0);
  await s.store.update(next => { next.peer = { binding: s.inbox.key, contextToken: 'PRIVATE-CONTEXT' }; });
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0].item_list[0].text_item.text, WAITING_NOTICE);
  assert.match(WAITING_NOTICE, /^[\x00-\x7f]*$/);
  await s.sync.setActivity(true, id);
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 1);
  const resumed = new TextSync(s.inbox, s.run, () => {}, () => false);
  await resumed.open(chatState());
  await resumed.setActivity(true, id);
  await resumed.flush(signal());
  assert.equal(s.sends.length, 1, 'reconnect must not repeat a waiting episode');
  await resumed.setActivity(false, id);
  await resumed.setActivity(true, id);
  await resumed.setActivity(false, id);
  await resumed.flush(signal());
  assert.equal(s.sends.length, 1, 'resolved wait must not deliver queued notice');
  assert.deepEqual(s.events, []);
});

test('optional notice failures do not block real messages and never retry uncertain notices', async () => {
  const s = await setup({ send: async message => {
    if (message.item_list[0].text_item.text === WAITING_NOTICE) throw new Error('PRIVATE-OPTIONAL-FAILURE');
  } });
  await s.sync.setActivity(true, randomUUID());
  await s.sync.flush(signal());
  assert.equal(s.store.snapshot().outbox[0].status, 'uncertain');
  await s.sync.started(randomUUID(), user('real user'));
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 2);
  assert.equal(s.sends[1].item_list[0].text_item.text, '[VS Code User]\nreal user');
  assert.deepEqual(results(s.events), [{ type: 'result', source: 'vscodeUser', outcome: 'api_accepted' }]);
  assert.doesNotMatch(s.logs.join('\n'), /PRIVATE-OPTIONAL/);
});

test('normal text precedes pending status; a paused old instance cannot send a late notice', async () => {
  const s = await setup();
  await s.sync.setActivity(true, randomUUID());
  await s.sync.started(randomUUID(), user('real user'));
  await s.sync.flush(signal());
  assert.equal(s.sends[0].item_list[0].text_item.text, '[VS Code User]\nreal user');
  assert.equal(s.sends[1].item_list[0].text_item.text, WAITING_NOTICE);
  await s.sync.setActivity(false);
  await s.sync.setActivity(true, randomUUID());
  s.sync.pauseActivity();
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 2);
});

test('a journal failure while queueing an optional notice is diagnosed once without blocking subsequent text', async () => {
  const s = await setup({ context: false });
  await s.sync.setActivity(true, randomUUID());
  await s.store.update(next => { next.peer = { binding: s.inbox.key, contextToken: 'PRIVATE-CONTEXT' }; });
  s.secrets.fail = true;
  await s.sync.flush(signal());
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 0);
  assert.equal(s.logs.filter(log => log.includes('Could not queue')).length, 1);
  s.secrets.fail = false;
  await s.sync.started(randomUUID(), user('real input'));
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0].item_list[0].text_item.text, '[VS Code User]\nreal input');
});

test('optional notices have a separate bounded quota and do not displace real messages or uncertain evidence', async () => {
  const s = await setup();
  await s.store.update(next => {
    next.outbox = Array.from({ length: 16 }, (_, i) => ({
      id: hash(`notice-${i}`), binding: s.inbox.key, runId: s.run, sourceId: `notice-${i}`,
      role: 'status', text: '', status: 'uncertain', sent: 0,
    }));
  });
  await s.sync.setActivity(true, randomUUID());
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 0);
  await s.sync.started(randomUUID(), user('real message despite unavailable optional notice'));
  await s.sync.flush(signal());
  assert.equal(s.sends.length, 1);
  assert.equal(s.store.snapshot().outbox.filter(entry => entry.role === 'status' && entry.status === 'uncertain').length, 16);
  assert.ok(s.logs.some(log => log.includes('uncertain notice history')));
});

test('runtime gates activity on ready/owner context, stops typing for all pending confirmations and resumes after them', async t => {
  const host = await fakeHost(t);
  const { vault: store } = await vault();
  await store.update(next => { next.peer = { binding: bindingKey(binding), contextToken: 'PRIVATE-CONTEXT' }; });
  const typing = [];
  const sends = [];
  const o = observer();
  const runtime = new ChannelRuntime({
    binding, vault: store, resolveHost: async () => host.target,
    api: {
      updates: async (_cursor, signal) => { await pause(10000, signal); return { msgs: [] }; },
      send: async message => sends.push(message),
      getTypingTicket: async (owner, context) => {
        assert.equal(owner, credentials.ownerId); assert.equal(context, 'PRIVATE-CONTEXT'); return 'PRIVATE-TICKET';
      },
      sendTyping: async (owner, ticket, status) => {
        assert.equal(owner, credentials.ownerId); assert.equal(ticket, 'PRIVATE-TICKET'); typing.push(status);
      },
    },
    assertAllowed() {}, assertScope: async () => {}, log() {}, status() {}, failed() {}, messages: o.hooks,
  });
  t.after(() => runtime.stop());
  await runtime.start();
  assert.deepEqual(typing, []);
  host.startEditorTurn('PRIVATE-EDITOR');
  await waitFor(() => typing.at(-1) === 1);
  const first = host.tool({ confirmed: null });
  const second = host.tool({ confirmed: null });
  await waitFor(() => typing.at(-1) === 2);
  await waitFor(() => sends.some(message => message.item_list[0].text_item.text === WAITING_NOTICE));
  host.emit({ type: 'chat/toolCallConfirmed', turnId: first.turn, toolCallId: first.toolCallId, approved: true, confirmed: 'user-action' });
  await pause(10, signal());
  assert.equal(typing.at(-1), 2);
  host.emit({ type: 'chat/toolCallConfirmed', turnId: second.turn, toolCallId: second.toolCallId, approved: true, confirmed: 'user-action' });
  await waitFor(() => typing.at(-1) === 1);
  host.answer('PRIVATE-FINAL');
  await waitFor(() => typing.at(-1) === 2);
  await waitFor(() => results(o.events).some(event => event.source === 'agentReply'));
  await runtime.stop();
  assert.equal(sends.filter(message => message.item_list[0].text_item.text === WAITING_NOTICE).length, 1);
  assert.deepEqual(o.events.filter(event => event.type === 'input'), [{ type: 'input', source: 'vscodeUser' }]);
  assert.equal(o.events.filter(event => event.type === 'completed').length, 1);
  assert.equal(results(o.events).length, 2);
});

test('failed scope validation cannot send typing or waiting notices from an initial busy snapshot', async t => {
  const host = await fakeHost(t, { busy: true });
  const { vault: store } = await vault();
  await store.update(next => { next.peer = { binding: bindingKey(binding), contextToken: 'PRIVATE-CONTEXT' }; });
  const runtime = new ChannelRuntime({
    binding, vault: store, resolveHost: async () => host.target,
    api: {
      updates: async () => assert.fail('must not poll'),
      send: async () => assert.fail('must not send'),
      getTypingTicket: async () => assert.fail('must not request typing before scope validation'),
      sendTyping: async () => assert.fail('must not show typing'),
    },
    assertAllowed() {}, assertScope: async () => { throw new SafeError('Wrong scope.'); },
    log() {}, status() {}, failed() {},
  });
  await assert.rejects(runtime.start(), /Wrong scope/);
  await runtime.stop();
});

test('newly observed failures and old baseline turns do not manufacture completed or successful messages', async t => {
  const host = await fakeHost(t);
  host.reject = 'chat/turnStarted';
  const s = await setup();
  const connection = await HostConnection.connect(host.target, signal(), s.run, 100);
  const bridge = await Bridge.open(connection, binding, s.inbox, signal(), () => {});
  t.after(async () => { await bridge.close(); await connection.close(); });
  await s.inbox.accept({ msgs: [message()] }, signal());
  await assert.rejects(bridge.deliverPending(signal()), /rejected/);
  assert.deepEqual(results(s.events), [{ type: 'result', source: 'wechatUser', outcome: 'failed', error_category: 'ahp-rejected' }]);
  s.tracker.results(await s.store.invalidateReplies(s.inbox.key));
  assert.equal(results(s.events).length, 1);
  const other = await setup();
  const id = randomUUID();
  const old = { ...chatState(), activeTurn: { id, message: user('old input'), responseParts: [] } };
  await other.sync.open(old);
  await other.sync.started(id, user('old input'));
  await other.sync.complete(turn(id));
  assert.deepEqual(other.events, []);
});

test('closing results respect actual transitions, persist observation even if disabled, and exclude notices', async () => {
  const s = await setup({ context: false });
  await s.inbox.accept({ msgs: [message()] }, signal());
  await s.sync.started(randomUUID(), user('pending outbound'));
  await s.sync.setActivity(true, randomUUID());
  s.tracker.results(await s.store.invalidateReplies(s.inbox.key));
  assert.deepEqual(results(s.events), [{ type: 'result', source: 'vscodeUser', outcome: 'cancelled' }]);
  let closed;
  await s.store.update(next => { closed = closingResults(next, undefined, true); });
  s.tracker.results(closed);
  assert.equal(results(s.events).at(-1).source, 'wechatUser');
  assert.equal(results(s.events).at(-1).outcome, 'cancelled');
  assert.deepEqual(closingResults(s.store.snapshot(), undefined, true), []);
});

test('v2 migration preserves pending and uncertain delivery state without replaying already completed events', async () => {
  const s = await setup();
  await s.sync.started(randomUUID(), user('keep pending'));
  const old = s.store.snapshot();
  old.version = 2;
  old.outbox.push({ ...old.outbox[0], id: 'a'.repeat(64), sourceId: 'old-uncertain', status: 'uncertain' });
  await s.secrets.store(SECRET_KEY, JSON.stringify(old));
  const migrated = await Vault.load(s.secrets);
  const state = migrated.snapshot();
  assert.equal(state.version, 3);
  assert.deepEqual(state.credentials, credentials);
  assert.equal(state.outbox[0].status, 'pending');
  assert.equal(state.outbox[1].status, 'uncertain');
  assert.equal(state.outbox[1].resultRecorded, true);
  assert.equal(state.peer.binding, bindingKey(binding));
});

test('new events have no private data or measurements, respect live usage consent and isolate observer failure', async () => {
  const fake = fakeTelemetry();
  const warnings = [];
  const telemetry = new Telemetry(() => new fake.Reporter(), text => warnings.push(text));
  for (const level of ['all', 'error', 'off', 'crash', 'all']) {
    fake.reporters[0].telemetryLevel = level;
    const before = fake.events.length;
    telemetry.messages.input('wechatUser');
    telemetry.messages.input('vscodeUser');
    telemetry.messages.completed(true);
    telemetry.messages.result('agentReply', 'uncertain', new SafeError('PRIVATE-ERROR-BODY', false, 'delivery'));
    assert.equal(fake.events.length - before, level === 'all' ? 4 : 0);
  }
  const before = fake.events.length;
  telemetry.messages.input('PRIVATE-MESSAGE');
  telemetry.messages.completed('PRIVATE-TEXT');
  telemetry.messages.result('agentReply', 'PRIVATE-RESULT', new Error('PRIVATE'));
  telemetry.messages.result('wechatUser', 'api_accepted');
  assert.equal(fake.events.length, before);
  assert.ok(fake.events.every(e => e.measurements === undefined));
  assert.doesNotMatch(JSON.stringify(fake.events), /PRIVATE|duration_ms|message_id/);
  await telemetry.dispose();
  const broken = new MessageEvents({
    input() { throw new Error('PRIVATE'); },
    completed() { throw new Error('PRIVATE'); },
    result() { throw new Error('PRIVATE'); },
  }, text => warnings.push(text));
  broken.input('wechatUser', 'PRIVATE-ID');
  broken.completed('PRIVATE-TURN', true);
  broken.result('wechatUser', 'PRIVATE-ID', 'uncertain');
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(warnings.join('\n'), /PRIVATE/);
});

test('re-enabling usage does not replay prompt/completion/results observed while disabled', async () => {
  const s = await setup();
  const fake = fakeTelemetry();
  const telemetry = new Telemetry(() => new fake.Reporter(), assert.fail);
  fake.reporters[0].telemetryLevel = 'off';
  const inbox = new Inbox(s.store, binding, s.api, () => {}, new MessageEvents(telemetry.messages));
  const sync = new TextSync(inbox, s.run, () => {}, () => false);
  await sync.open(chatState());
  const id = randomUUID();
  await sync.started(id, user('PRIVATE-DISABLED'));
  await sync.complete(turn(id));
  await sync.flush(signal());
  assert.equal(fake.events.length, 0);
  fake.reporters[0].telemetryLevel = 'all';
  const restored = new TextSync(inbox, s.run, () => {}, () => false);
  await restored.open({ ...chatState(), turns: [turn(id)] });
  await restored.started(id, user('PRIVATE-DISABLED'));
  await restored.complete(turn(id));
  await restored.flush(signal());
  assert.equal(fake.events.length, 0);
  await restored.started(randomUUID(), user('new enabled input'));
  await restored.flush(signal());
  assert.deepEqual(fake.events.map(event => event.name), [
    'wechatAHP.message.vscodeUser', 'wechatAHP.message.vscodeUser.result',
  ]);
  await telemetry.dispose();
});
