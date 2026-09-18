import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  apiBase, bindingKey, chunks, diagnostic, hash, Inbox, incoming, login, MAX_PENDING, parseWire, qrHtml,
  SafeError, SECRET_KEY, TextSync, Vault, WeixinApi,
} from '../.test-build/core.mjs';
import { binding, chatState, credentials, fakeWeixin, message, signal, vault } from './helpers.mjs';

test('lossless JSON keeps uint64 IDs and never rewrites text containing JSON-like fields', () => {
  const result = parseWire('{"message_id":18446744073709551615,"msg_id":10,"text":"{\\"message_id\\":18446744073709551615}"}');
  assert.equal(result.message_id, '18446744073709551615');
  assert.equal(result.msg_id, 10);
  assert.equal(result.text, '{"message_id":18446744073709551615}');
  assert.throws(() => parseWire('{"message_id":01}'));
});

test('API origins fail closed on external hosts, credentials, paths, redirects and ports', () => {
  for (const value of ['http://ilinkai.weixin.qq.com', 'https://evil.test', 'https://ilinkai.weixin.qq.com.evil.test',
    'https://user:pass@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443',
    'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com?token=secret', 'https://ilinkai.weixin.qq.com\\evil']) {
    assert.throws(() => apiBase(value), SafeError);
  }
  assert.equal(apiBase(credentials.base), credentials.base);
});

test('Weixin serialized POST has contract headers, cursor and explicit success', async t => {
  const fake = await fakeWeixin(t, [{ ret: 0, msgs: [message()], get_updates_buf: 'cursor-2' }]);
  const batch = await fake.api.updates('cursor-1', signal());
  assert.equal(batch.cursor, 'cursor-2');
  assert.equal(fake.polls[0].get_updates_buf, 'cursor-1');
  const headers = fake.requests[0].headers;
  assert.equal(headers.authorization, `Bearer ${credentials.token}`);
  assert.equal(headers.authorizationtype, 'ilink_bot_token');
  assert.equal(headers['ilink-app-id'], 'bot');
  assert.equal(headers['ilink-app-clientversion'], '256');
  assert.match(Buffer.from(headers['x-wechat-uin'], 'base64').toString(), /^\d+$/);
});

test('HTTP/business errors are explicit and raw response/URL details cannot leak', async () => {
  for (const [status, body, retryable] of [
    [401, 'SECRET', false], [429, 'SECRET', true], [503, 'SECRET', true],
    [200, '{"ret":-14,"errmsg":"SECRET"}', false], [200, '{"ret":1,"errmsg":"SECRET"}', false],
    [200, 'not-json-SECRET', false], [200, '{"ret":"0"}', false],
  ]) {
    const api = new WeixinApi(credentials.base, credentials.token, async () => new Response(body, { status }));
    await assert.rejects(api.updates('', signal()), error => {
      assert.equal(error.retryable, retryable);
      assert.doesNotMatch(diagnostic(error), /SECRET|TEST-ONLY/);
      return true;
    });
  }
  const api = new WeixinApi(credentials.base, credentials.token, async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new Error('SECRET credential URL');
  });
  await assert.rejects(api.updates('', signal()), /network\/TLS/);
  assert.doesNotMatch(diagnostic(new Error('SECRET')), /SECRET/);
});

test('cancellation does not become success or a retryable Weixin failure', async () => {
  const cancel = new AbortController();
  cancel.abort(new Error('cancelled fixture'));
  let invoked = false;
  const api = new WeixinApi(credentials.base, credentials.token, async () => { invoked = true; return new Response('{}'); });
  await assert.rejects(api.updates('', cancel.signal), /cancelled fixture/);
  assert.equal(invoked, false);
  const noSuccess = new WeixinApi(credentials.base, credentials.token, async () => new Response('{}'));
  await noSuccess.send({}, signal());
});

test('sendmessage matches documented omitted-ret success while rejecting explicit HTTP/business/JSON errors', async () => {
  for (const body of ['{}', '{"errmsg":""}', '{"ret":0}', '{"errcode":0}']) {
    await new WeixinApi(credentials.base, credentials.token, async () => new Response(body)).send({}, signal());
  }
  for (const body of ['{"ret":1}', '{"errcode":7}', '{"ret":0,"errcode":-14}', '{"ret":null}', '[]', 'not-json', '']) {
    await assert.rejects(new WeixinApi(credentials.base, credentials.token, async () => new Response(body)).send({}, signal()), SafeError);
  }
});

test('sender, recipient, direct-text, size and state filtering are fail closed', () => {
  assert.ok('message' in incoming(message(), credentials));
  for (const extra of [
    { from_user_id: 'stranger' }, { to_user_id: 'other-bot' }, { group_id: 'group' },
    { message_type: 2 }, { message_state: 1 }, { context_token: '' },
    { item_list: [{ type: 2 }] }, { message_id: Number.MAX_SAFE_INTEGER + 1 },
    { delete_time_ms: 1 }, { item_list: [{ type: 1, text_item: { text: 'x'.repeat(17000) } }] },
  ]) assert.ok('dropped' in incoming(message('1', 'hello', extra), credentials));
  assert.ok('dropped' in incoming(message(), { ...credentials, ownerId: undefined }));
});

test('cursor and immutable private route are persisted atomically; duplicate events stay deduplicated after reload', async () => {
  const { secrets, vault: store } = await vault();
  const logs = [];
  const inbox = new Inbox(store, binding, {}, log => logs.push(log));
  await inbox.accept({ msgs: [message(), message(), message('2', 'do not log', { from_user_id: 'stranger' })], cursor: 'cursor-new' }, signal());
  const saved = secrets.state();
  assert.equal(saved.cursor, 'cursor-new');
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].contextToken, 'TEST-PRIVATE-CONTEXT-1');
  assert.equal(saved.messages[0].binding, bindingKey(binding));
  assert.deepEqual([...secrets.data.keys()], [SECRET_KEY]);
  const reopened = await Vault.load(secrets);
  await new Inbox(reopened, binding, {}, () => {}).accept({ msgs: [message()], cursor: 'cursor-next' }, signal());
  assert.equal(reopened.snapshot().messages.length, 1);
  assert.doesNotMatch(logs.join('\n'), /TEST-PRIVATE|do not log|stranger/);
  secrets.fail = true;
  await assert.rejects(inbox.accept({ msgs: [message('3')], cursor: 'must-not-commit' }, signal()), /SecretStorage write failed/);
  assert.equal(inbox.vault.snapshot().cursor, 'cursor-new');
});

test('bounded inbox refuses overflow without advancing the cursor or discarding messages', async () => {
  const { vault: store } = await vault();
  const inbox = new Inbox(store, binding, {}, () => {});
  await inbox.accept({ msgs: Array.from({ length: MAX_PENDING }, (_, i) => message(String(i))), cursor: 'full' }, signal());
  await assert.rejects(inbox.accept({ msgs: [message('overflow')], cursor: 'lost' }, signal()), /full/);
  assert.equal(store.snapshot().cursor, 'full');
  assert.equal(store.snapshot().messages.length, MAX_PENDING);
});

test('sync uses original peer/context and codepoint-safe chunks without retrying ambiguous sends after reload', async () => {
  const { secrets, vault: store } = await vault();
  const sends = [];
  const api = { send: async msg => { sends.push(msg); if (sends.length === 2) throw new SafeError('fixture send failure'); } };
  const inbox = new Inbox(store, binding, api, () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  const runId = randomUUID();
  const sync = new TextSync(inbox, runId, () => {}, () => false);
  await sync.open(chatState());
  const text = '\u{1F43C}'.repeat(2000);
  assert.equal(chunks(text).join(''), text);
  assert.ok(chunks(text).every(chunk => Buffer.byteLength(chunk) <= 3500 && chunk.isWellFormed()));
  await sync.started(randomUUID(), { text, origin: { kind: 'user' } });
  await assert.rejects(sync.flush(signal()), /1\/3 confirmed parts/);
  assert.equal(sends[0].to_user_id, credentials.ownerId);
  assert.equal(sends[0].context_token, 'TEST-PRIVATE-CONTEXT-1');
  const restored = await Vault.load(secrets);
  const next = new TextSync(new Inbox(restored, binding, api, () => {}), runId, () => {}, () => false);
  await next.open(chatState());
  await next.flush(signal());
  assert.equal(sends.length, 2);
  assert.equal(restored.snapshot().outbox[0].status, 'uncertain');
  assert.equal(restored.snapshot().outbox[0].sent, 1);
});

test('pending sync cannot be rerouted to a different binding or sent after disconnect', async () => {
  const { vault: store } = await vault();
  const api = { send: async () => assert.fail('must not send') };
  const inbox = new Inbox(store, binding, api, () => {});
  await inbox.accept({ msgs: [message()] }, signal());
  const sync = new TextSync(inbox, randomUUID(), () => {}, () => false);
  await sync.open(chatState());
  await sync.started(randomUUID(), { text: 'old binding text', origin: { kind: 'user' } });
  const other = new TextSync(new Inbox(store, { ...binding, chat: 'ahp-chat:/different' }, api, () => {}), randomUUID(), () => {}, () => false);
  await other.open(chatState());
  await other.flush(signal());
  assert.equal(store.snapshot().outbox[0].status, 'cancelled');
  await sync.open(chatState());
  await sync.started(randomUUID(), { text: 'after reconnect', origin: { kind: 'user' } });
  await store.invalidateReplies(bindingKey(binding));
  await sync.flush(signal());
  assert.ok(store.snapshot().outbox.every(entry => entry.status === 'cancelled'));
});

test('QR login handles redirect/verification and requires independently authenticated owner', async () => {
  const statuses = [
    { status: 'scaned_but_redirect', redirect_host: 'ilink-region.weixin.qq.com' },
    { status: 'need_verifycode' },
    { status: 'confirmed', bot_token: credentials.token, ilink_bot_id: credentials.botId, ilink_user_id: credentials.ownerId },
  ];
  const seen = [];
  const makeApi = base => ({
    base, request: async endpoint => {
      seen.push([base, endpoint]);
      return endpoint.startsWith('ilink/bot/get_bot_qrcode') ? { qrcode: 'test-seed', qrcode_img_content: 'test-content' } : statuses.shift();
    },
  });
  const account = await login({ qr: async text => assert.equal(text, 'test-content'), verify: async () => '123456', log() {} }, signal(), makeApi, async () => {});
  assert.equal(account.ownerId, credentials.ownerId);
  assert.equal(account.base, 'https://ilink-region.weixin.qq.com');
  assert.match(seen.at(-1)[1], /verify_code=123456/);
  const missing = base => ({ base, request: async endpoint => endpoint.includes('get_bot_qrcode')
    ? { qrcode: 'test', qrcode_img_content: 'test' }
    : { status: 'confirmed', bot_token: credentials.token, ilink_bot_id: credentials.botId } });
  await assert.rejects(login({ qr: async () => {}, verify: async () => '', log() {} }, signal(), missing, async () => {}), /reliable owner/);
});

test('QR unknown/expired/blocked/external redirect states fail; HTML has no active script or external navigation', async () => {
  for (const status of [{ status: 'expired' }, { status: 'verify_code_blocked' }, { status: 'binded_redirect' },
    { status: 'unknown' }, { status: 'scaned_but_redirect', redirect_host: 'evil.test' }]) {
    const make = base => ({ base, request: async endpoint => endpoint.includes('get_bot_qrcode') ? { qrcode: 'test', qrcode_img_content: 'test' } : status });
    await assert.rejects(login({ qr: async () => {}, verify: async () => '', log() {} }, signal(), make, async () => {}), SafeError);
  }
  const html = qrHtml('data:image/png;base64,YQ==');
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script|href=|https:|onclick/);
  assert.throws(() => qrHtml('"><script>alert(1)</script>'));
  assert.equal(hash('same'), hash('same'));
});
