import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Inbox, TextSync, Vault, SECRET_KEY, bindingKey, hash, pause } from '../.test-build/core.mjs';
import { binding, chatState, credentials, MemorySecrets, message, signal, vault } from './helpers.mjs';

const user = text => ({ text, origin: { kind: 'user' } });
const completed = (id, text) => ({
  id, state: 'complete', message: user('editor input'),
  responseParts: [{ kind: 'markdown', id: 'answer', content: text }],
});

test('v1 journal migration preserves credentials, cursor and legacy uncertain send evidence', async () => {
  const secrets = new MemorySecrets();
  const eventId = hash('legacy-event');
  await secrets.store(SECRET_KEY, JSON.stringify({
    version: 1, credentials, cursor: 'keep-cursor', seen: [eventId],
    messages: [{
      id: eventId, messageId: 'legacy-id', text: '', contextToken: 'PRIVATE-LEGACY-CONTEXT',
      binding: bindingKey(binding), receivedAt: Date.now(), delivery: 'closed',
      outbound: { digest: hash('already attempted'), status: 'uncertain', sent: 0 },
    }],
  }));
  const loaded = await Vault.load(secrets);
  assert.equal(loaded.snapshot().version, 3);
  assert.equal(loaded.snapshot().cursor, 'keep-cursor');
  assert.equal(loaded.snapshot().credentials.token, credentials.token);
  const api = { send: async () => assert.fail('migration must not resend') };
  const sync = new TextSync(new Inbox(loaded, binding, api, () => {}), randomUUID(), () => {}, () => false);
  await sync.open(chatState());
  await sync.flush(signal());
  assert.equal(secrets.state().messages[0].outbound.status, 'uncertain');
  assert.equal(secrets.state().version, 3);
});

test('sent text and historical snapshots are never replayed after reconnect', async () => {
  const { secrets, vault: store } = await vault();
  const sends = [];
  const api = { send: async message => sends.push(message) };
  const inbox = new Inbox(store, binding, api, () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  const run = randomUUID();
  const sync = new TextSync(inbox, run, () => {}, () => false);
  await sync.open(chatState());
  const id = randomUUID();
  await sync.started(id, user('new user'));
  await sync.complete(completed(id, 'new assistant'));
  await sync.flush(signal());
  assert.equal(sends.length, 2);
  const loaded = await Vault.load(secrets);
  const restored = new TextSync(new Inbox(loaded, binding, api, () => {}), run, () => {}, () => false);
  await restored.open({ ...chatState(), turns: [...chatState().turns, completed(id, 'new assistant')] });
  await restored.flush(signal());
  assert.equal(sends.length, 2);
  assert.ok(loaded.snapshot().outbox.every(entry => !entry.text && !entry.route));
});

test('SecretStorage failure before send prevents network delivery; failure after acceptance remains uncertain', async () => {
  const { secrets, vault: store } = await vault();
  let sends = 0;
  const api = { send: async () => { sends++; secrets.fail = true; } };
  const inbox = new Inbox(store, binding, api, () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  const run = randomUUID();
  const sync = new TextSync(inbox, run, () => {}, () => false);
  await sync.open(chatState());
  await sync.started(randomUUID(), user('durable user'));
  secrets.fail = true;
  await assert.rejects(sync.flush(signal()), /SecretStorage write failed/);
  assert.equal(sends, 0);
  secrets.fail = false;
  await assert.rejects(sync.flush(signal()), /SecretStorage write failed/);
  assert.equal(sends, 1);
  secrets.fail = false;
  const loaded = await Vault.load(secrets);
  assert.equal(loaded.snapshot().outbox[0].status, 'sending');
  const restored = new TextSync(new Inbox(loaded, binding, api, () => {}), run, () => {}, () => false);
  await restored.open(chatState());
  await restored.flush(signal());
  assert.equal(sends, 1);
  assert.equal(loaded.snapshot().outbox[0].status, 'uncertain');
});

test('cancelling an in-flight send preserves uncertainty and never resumes it on next connect', async () => {
  const { vault: store } = await vault();
  const abort = new AbortController();
  let sends = 0;
  const api = { send: async (_message, signal) => { sends++; abort.abort(); await pause(100, signal); } };
  const inbox = new Inbox(store, binding, api, () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  const sync = new TextSync(inbox, randomUUID(), () => {}, () => false);
  await sync.open(chatState());
  await sync.started(randomUUID(), user('cancel in progress'));
  await assert.rejects(sync.flush(abort.signal));
  assert.equal(store.snapshot().outbox[0].status, 'uncertain');
  const next = new TextSync(inbox, randomUUID(), () => {}, () => false);
  await next.open(chatState());
  await next.flush(signal());
  assert.equal(sends, 1);
});

test('outbox saturation refuses new events without deleting uncertain sends', async () => {
  const { vault: store } = await vault();
  const inbox = new Inbox(store, binding, {}, () => {});
  const run = randomUUID();
  const sync = new TextSync(inbox, run, () => {}, () => false);
  await sync.open(chatState());
  await store.update(next => {
    next.outbox = Array.from({ length: 256 }, (_, index) => ({
      id: hash(`uncertain-${index}`), binding: inbox.key, runId: run, sourceId: `source-${index}`,
      role: 'user', text: '', status: 'uncertain', sent: 0,
    }));
  });
  await assert.rejects(sync.started(randomUUID(), user('must not discard')), /outbox is full/);
  assert.equal(store.snapshot().outbox.length, 256);
  assert.equal(store.snapshot().sync.turns.length, 0);
});

test('known private context remains blocked after prior message context is cleared', async () => {
  const { vault: store } = await vault();
  const inbox = new Inbox(store, binding, {}, () => {});
  await inbox.accept({ msgs: [message('route')] }, signal());
  await store.update(next => { next.messages[0].contextToken = ''; next.messages[0].delivery = 'closed'; });
  const sync = new TextSync(inbox, randomUUID(), () => {}, () => false);
  await sync.open(chatState());
  await assert.rejects(sync.started(randomUUID(), user('TEST-PRIVATE-CONTEXT-route')), /credential/);
});

test('preexisting active and queued messages stay outside the new-sync baseline', async () => {
  const { vault: store } = await vault();
  const inbox = new Inbox(store, binding, { send: async () => assert.fail('old turn must not send') }, () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  const active = randomUUID();
  const queued = randomUUID();
  const snapshot = {
    ...chatState(),
    activeTurn: { id: active, message: user('old active'), responseParts: [] },
    queuedMessages: [{ id: queued, message: user('old queue') }],
  };
  const sync = new TextSync(inbox, randomUUID(), () => {}, () => false);
  await sync.open(snapshot);
  await sync.started(active, user('old active'));
  await sync.started(randomUUID(), user('old queue'), queued);
  await sync.complete(completed(active, 'old answer'));
  await sync.flush(signal());
  assert.equal(store.snapshot().outbox.length, 0);
});
