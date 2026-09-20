import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WeixinApi, VERSION, SafeError, diagnostic, TypingController } from '../.test-build/core.mjs';

const owner = 'OFFLINE-OWNER@im.wechat';
const context = 'OFFLINE-CONTEXT-SECRET';
const ticket = 'OFFLINE-TICKET-SECRET';
const token = 'OFFLINE-BOT-TOKEN';
const base = 'https://ilinkai.weixin.qq.com';
const signal = () => new AbortController().signal;
const baseInfo = { channel_version: VERSION, bot_agent: `WechatAHP-VSCode/${VERSION}` };

function wire(reply, status = 200) {
  return new WeixinApi(base, token, async () => new Response(reply, { status }));
}

function safe(error) {
  assert.ok(error instanceof SafeError);
  assert.doesNotMatch(diagnostic(error), /OFFLINE-|PRIVATE-RESPONSE|RAW-NETWORK/);
  return true;
}

test('typing wire carries only the authorized owner, ticket/context and normal authenticated metadata', async () => {
  const requests = [];
  const api = new WeixinApi(base, token, async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(requests.length === 1 ? JSON.stringify({ ret: 0, typing_ticket: ticket }) : '');
  });
  assert.equal(await api.getTypingTicket(owner, context, signal()), ticket);
  await api.sendTyping(owner, ticket, 1, signal());
  await api.sendTyping(owner, ticket, 2, signal());
  assert.deepEqual(requests.map(request => request.url), [
    `${base}/ilink/bot/getconfig`, `${base}/ilink/bot/sendtyping`, `${base}/ilink/bot/sendtyping`,
  ]);
  assert.deepEqual(requests.map(request => request.body), [
    { ilink_user_id: owner, context_token: context, base_info: baseInfo },
    { ilink_user_id: owner, typing_ticket: ticket, status: 1, base_info: baseInfo },
    { ilink_user_id: owner, typing_ticket: ticket, status: 2, base_info: baseInfo },
  ]);
  for (const { options, url } of requests) {
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers.AuthorizationType, 'ilink_bot_token');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['iLink-App-Id'], 'bot');
    assert.equal(options.headers['iLink-App-ClientVersion'], '258');
    assert.match(Buffer.from(options.headers['X-WECHAT-UIN'], 'base64').toString(), /^\d+$/);
    assert.ok(options.signal instanceof AbortSignal);
    assert.doesNotMatch(url, /OFFLINE-/);
  }
});

test('getconfig requires ret=0 and distinguishes absent capability from malformed tickets', async () => {
  assert.equal(await wire('{"ret":0}').getTypingTicket(owner, context, signal()), undefined);
  assert.equal(await wire(JSON.stringify({ ret: 0, typing_ticket: ticket })).getTypingTicket(owner, context, signal()), ticket);
  assert.equal(await wire(JSON.stringify({ ret: 0, typing_ticket: 'x'.repeat(8192) })).getTypingTicket(owner, context, signal()), 'x'.repeat(8192));
  for (const body of [{}, { errcode: 0, typing_ticket: ticket }, { typing_ticket: ticket },
    { ret: 1, typing_ticket: ticket }, { ret: '0', typing_ticket: ticket }, { ret: null, typing_ticket: ticket },
    { ret: 0, errcode: 5, typing_ticket: ticket },
    ...['', ' ', null, 1, {}, [], 'x'.repeat(8193), '\ud800'].map(value => ({ ret: 0, typing_ticket: value }))]) {
    await assert.rejects(wire(JSON.stringify(body)).getTypingTicket(owner, context, signal()), safe);
  }
});

test('typing accepts only empty or valid object HTTP successes; nonempty business errors still fail', async () => {
  for (const [body, status] of [[null, 204], [null, 200], ['', 200], ['{}', 200],
    ['{"ret":0}', 200], ['{"errcode":0}', 200], ['{"ret":0,"errcode":0}', 200]]) {
    await wire(body, status).sendTyping(owner, ticket, 1, signal());
  }
  for (const body of [' ', 'not-json PRIVATE-RESPONSE', '[]', 'null', '0', 'true', '"text"',
    '{"ret":1}', '{"errcode":-14}', '{"ret":0,"errcode":7}', '{"ret":null}', '{"ret":"0"}',
    '{"errcode":0.5}', '{"ret":9007199254740993}']) {
    await assert.rejects(wire(body).sendTyping(owner, ticket, 1, signal()), safe);
  }
});

test('typing additions preserve strict empty-response handling for sendmessage, getupdates and getconfig', async () => {
  for (const [body, status] of [['', 200], [null, 204]]) {
    const api = wire(body, status);
    await assert.rejects(api.send({}, signal()), safe);
    await assert.rejects(api.updates('', signal()), safe);
    await assert.rejects(api.getTypingTicket(owner, context, signal()), safe);
    await assert.rejects(api.request('ilink/bot/sendtyping', undefined, signal()), safe);
  }
  await wire('{}').send({}, signal());
  await assert.rejects(wire('{}').updates('', signal()), safe);
});

test('typing validates owner, context, ticket and status before any network request', async () => {
  const api = new WeixinApi(base, token, async () => assert.fail('invalid inputs must not reach fetch'));
  for (const invalid of ['', 'with space', 'with\nnewline', 'x'.repeat(257), '\ud800', null, 7]) {
    await assert.rejects(api.getTypingTicket(invalid, context, signal()), safe);
    await assert.rejects(api.sendTyping(invalid, ticket, 1, signal()), safe);
  }
  for (const invalid of ['', ' ', 'x'.repeat(8193), '\ud800', null, 7, undefined]) {
    await assert.rejects(api.getTypingTicket(owner, invalid, signal()), safe);
    await assert.rejects(api.sendTyping(owner, invalid, 1, signal()), safe);
  }
  for (const status of [0, 3, '1', null, undefined]) {
    await assert.rejects(api.sendTyping(owner, ticket, status, signal()), safe);
  }
  assert.throws(() => new WeixinApi('http://ilinkai.weixin.qq.com', token), SafeError);
  assert.throws(() => new WeixinApi('https://external.example', token), SafeError);
});

test('typing HTTP, network and malformed-body failures stay bounded and redacted', async () => {
  for (const status of [301, 401, 403, 429, 500, 503]) {
    const api = wire('PRIVATE-RESPONSE', status);
    for (const operation of [
      () => api.getTypingTicket(owner, context, signal()),
      () => api.sendTyping(owner, ticket, 2, signal()),
    ]) {
      await assert.rejects(operation(), error => {
        safe(error);
        assert.equal(error.retryable, status === 429 || status >= 500);
        return true;
      });
    }
  }
  for (const body of ['x'.repeat(1024 * 1024 + 1), new Uint8Array([0xc0, 0xaf])]) {
    await assert.rejects(wire(body).sendTyping(owner, ticket, 1, signal()), safe);
  }
  const api = new WeixinApi(base, token, async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new Error('RAW-NETWORK OFFLINE-BOT-TOKEN');
  });
  await assert.rejects(api.sendTyping(owner, ticket, 1, signal()), safe);
});

test('typing pre-cancellation prevents fetch and cancellation interrupts a non-cooperative fetch', async () => {
  const abort = new AbortController();
  const requests = [];
  const api = new WeixinApi(base, token, (_url, options) => {
    requests.push(options);
    return new Promise(() => {});
  });
  abort.abort();
  await assert.rejects(api.getTypingTicket(owner, context, abort.signal), { name: 'AbortError' });
  await assert.rejects(api.sendTyping(owner, ticket, 1, abort.signal), { name: 'AbortError' });
  assert.equal(requests.length, 0);
  const next = new AbortController();
  const sending = api.sendTyping(owner, ticket, 1, next.signal);
  next.abort();
  await assert.rejects(sending, { name: 'AbortError' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, true);
});

test('typing request deadlines cover fetch, streaming body and stalled body cleanup', async () => {
  for (const mode of ['fetch', 'body']) {
    let abortedSignal;
    let cancelled = false;
    const api = new WeixinApi(base, token, async (_url, options) => {
      abortedSignal = options.signal;
      if (mode === 'fetch') return new Promise(() => {});
      return new Response(new ReadableStream({
        cancel() { cancelled = true; return new Promise(() => {}); },
      }));
    });
    await Promise.all([
      assert.rejects(api.request('ilink/bot/sendtyping', {}, signal(), 5), error => {
        safe(error);
        assert.equal(error.kind, 'timeout');
        return true;
      }),
      delay(20),
    ]);
    assert.equal(abortedSignal.aborted, true);
    if (mode === 'body') assert.equal(cancelled, true);
  }
  const api = new WeixinApi(base, token, async () => new Response(new ReadableStream({
    cancel: () => new Promise(() => {}),
  }), { status: 503 }));
  await assert.rejects(api.sendTyping(owner, ticket, 2, signal()), safe);
});

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

class Scheduler {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, milliseconds) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + milliseconds, callback });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  async tick(milliseconds) {
    await settle();
    const end = this.time + milliseconds;
    let ticks = 0;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++ticks < 10_000, 'scheduler must not spin');
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.time = end;
    await settle();
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, hooks = {}, options = {}) {
  const scheduler = new Scheduler();
  const calls = [];
  const logs = [];
  let inFlight = 0;
  let maxInFlight = 0;
  async function call(entry, run) {
    calls.push({ ...entry, at: scheduler.now() });
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try { return await run(); } finally { inFlight--; }
  }
  const api = {
    updates: async () => assert.fail('typing must not poll messages'),
    send: async () => assert.fail('typing must not send messages or notices'),
    getTypingTicket: (target, contextToken, signal) => call({ kind: 'config', target, context: contextToken, signal },
      () => hooks.config ? hooks.config(contextToken, signal) : ticket),
    sendTyping: (target, value, status, signal) => call({ kind: 'typing', target, ticket: value, status, signal },
      () => hooks.typing?.(status, signal, value)),
  };
  const controller = new TypingController({ api, ownerId: owner, log: message => logs.push(message), scheduler, ...options });
  t.after(async () => {
    const disposing = controller.dispose();
    await scheduler.tick(5000);
    await disposing;
    assert.equal(scheduler.timers.size, 0);
    assert.equal(maxInFlight <= 1, true, 'typing requests must never overlap');
    assert.doesNotMatch(logs.join('\n'), /OFFLINE-|RAW-|PRIVATE-/);
  });
  return {
    controller, scheduler, calls, logs, api,
    get inFlight() { return inFlight; },
    get maxInFlight() { return maxInFlight; },
    configs: () => calls.filter(call => call.kind === 'config'),
    statuses: () => calls.filter(call => call.kind === 'typing'),
  };
}

test('controller is passive until a Busy update has a usable context; incomplete adapters stay silent', async t => {
  const f = fixture(t);
  await settle();
  assert.equal(f.calls.length, 0);
  for (const state of ['Unknown', 'Idle', 'Awaiting input', 'Error']) f.controller.update(state, context);
  for (const value of [undefined, '', ' ', 'x'.repeat(8193), '\ud800', 7]) f.controller.update('Busy', value);
  await f.scheduler.tick(100_000);
  assert.equal(f.calls.length, 0);
  f.controller.update('Busy', context);
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1]);
  for (const adapter of [{}, { getTypingTicket: async () => assert.fail('incomplete capability') },
    { sendTyping: async () => assert.fail('incomplete capability') }]) {
    const old = new TypingController({ api: adapter, ownerId: owner, log: () => assert.fail('legacy adapters stay silent'), scheduler: f.scheduler });
    old.update('Busy', context);
    await old.dispose();
  }
});

test('five-second keepalive uses one cached ticket and duplicate vault updates do not restart timers', async t => {
  const f = fixture(t);
  f.controller.update('Busy', context);
  await settle();
  assert.equal(f.configs().length, 1);
  assert.deepEqual(f.statuses().map(call => [call.status, call.at]), [[1, 0]]);
  for (let i = 0; i < 100; i++) f.controller.update('Busy', context);
  await f.scheduler.tick(4999);
  assert.equal(f.statuses().length, 1);
  await f.scheduler.tick(1);
  assert.deepEqual(f.statuses().map(call => [call.status, call.at]), [[1, 0], [1, 5000]]);
  await f.scheduler.tick(15_000);
  assert.equal(f.configs().length, 1);
  assert.equal(f.statuses().length, 5);
  assert.equal(f.maxInFlight, 1);
  assert.ok(f.calls.every(call => call.target === owner));
});

test('every non-Busy state stops typing and a later Busy state resumes without new tickets', async t => {
  for (const state of ['Idle', 'Awaiting input', 'Error', 'Unknown']) {
    await t.test(state, async t => {
      const f = fixture(t);
      f.controller.update('Busy', context);
      await settle();
      f.controller.update(state, context);
      f.controller.update(state, context);
      await settle();
      assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
      await f.scheduler.tick(20_000);
      assert.equal(f.statuses().length, 2);
      f.controller.update('Busy', context);
      await settle();
      assert.deepEqual(f.statuses().map(call => call.status), [1, 2, 1]);
      assert.equal(f.configs().length, 1);
    });
  }
});

test('Busy -> Awaiting input -> Busy resumes immediately within five seconds and resets only its keepalive', async t => {
  const f = fixture(t);
  f.controller.update('Busy', context);
  await f.scheduler.tick(1000);
  f.controller.update('Awaiting input', context);
  await f.scheduler.tick(1000);
  f.controller.update('Busy', context);
  await settle();
  assert.deepEqual(f.statuses().map(call => [call.status, call.at]), [[1, 0], [2, 1000], [1, 2000]]);
  for (let i = 0; i < 100; i++) f.controller.update('Busy', context);
  await f.scheduler.tick(4999);
  assert.equal(f.statuses().length, 3);
  await f.scheduler.tick(1);
  assert.deepEqual(f.statuses().map(call => [call.status, call.at]), [[1, 0], [2, 1000], [1, 2000], [1, 7000]]);
  assert.equal(f.configs().length, 1);
});

test('lost context stops typing rather than guessing a route', async t => {
  const f = fixture(t);
  f.controller.update('Busy', context);
  await settle();
  f.controller.update('Busy');
  await settle();
  await f.scheduler.tick(20_000);
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
});

test('stop after an in-flight start fences its late response and cancels with an independent signal', async t => {
  const start = deferred();
  const f = fixture(t, { typing: status => status === 1 ? start.promise : undefined });
  f.controller.update('Busy', context);
  await settle();
  const started = f.statuses()[0];
  f.controller.update('Idle', context);
  await settle();
  assert.equal(started.signal.aborted, true);
  assert.deepEqual(f.statuses().map(call => call.status), [1]);
  start.resolve();
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
  assert.equal(f.statuses()[1].signal.aborted, false);
  assert.notEqual(f.statuses()[1].signal, started.signal);
  await f.scheduler.tick(20_000);
  assert.equal(f.statuses().length, 2);
});

test('Busy -> waiting -> Busy during an in-flight start cancels the old attempt before resuming', async t => {
  const first = deferred();
  let count = 0;
  const f = fixture(t, { typing: status => status === 1 && ++count === 1 ? first.promise : undefined });
  f.controller.update('Busy', context);
  await settle();
  f.controller.update('Awaiting input', context);
  f.controller.update('Busy', context);
  first.resolve();
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2, 1]);
  await f.scheduler.tick(4999);
  assert.equal(f.statuses().length, 3);
  await f.scheduler.tick(1);
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2, 1, 1]);
});

test('a new Busy episode waits for its pending cancel, then starts immediately without overlapping', async t => {
  const cancel = deferred();
  const f = fixture(t, { typing: status => status === 2 ? cancel.promise : undefined });
  f.controller.update('Busy', context);
  await f.scheduler.tick(1000);
  f.controller.update('Awaiting input', context);
  await settle();
  f.controller.update('Busy', context);
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
  assert.equal(f.statuses()[1].signal.aborted, false);
  cancel.resolve();
  await settle();
  assert.deepEqual(f.statuses().map(call => [call.status, call.at]), [[1, 0], [2, 1000], [1, 1000]]);
});

test('a failed cancel does not bypass the prior keepalive deadline on a new Busy episode', async t => {
  const f = fixture(t, { typing: status => {
    if (status === 2) throw new Error('RAW-CANCEL-FAILURE');
  } });
  f.controller.update('Busy', context);
  await f.scheduler.tick(1000);
  f.controller.update('Awaiting input', context);
  await f.scheduler.tick(1000);
  f.controller.update('Busy', context);
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
  await f.scheduler.tick(3000);
  assert.deepEqual(f.statuses().map(call => [call.status, call.at]), [[1, 0], [2, 1000], [1, 5000]]);
});

test('updates during in-flight cancellation do not cancel the next successful start', async t => {
  const cancel = deferred();
  const f = fixture(t, { typing: status => status === 2 ? cancel.promise : undefined });
  f.controller.update('Busy', context);
  await settle();
  f.controller.update('Idle', context);
  await settle();
  f.controller.update('Busy', context);
  f.controller.update('Busy', 'OFFLINE-CONTEXT-NEW');
  assert.equal(f.statuses()[1].signal.aborted, false);
  cancel.resolve();
  await settle();
  await f.scheduler.tick(5000);
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2, 1]);
});

test('a slow keepalive never overlaps other work, even if its adapter ignores cancellation', async t => {
  const pending = deferred();
  let starts = 0;
  const f = fixture(t, { typing: status => status === 1 && ++starts === 2 ? pending.promise : undefined });
  f.controller.update('Busy', context);
  await f.scheduler.tick(5000);
  assert.equal(f.statuses().length, 2);
  await f.scheduler.tick(30_000);
  assert.equal(f.statuses().length, 2);
  assert.equal(f.statuses()[1].signal.aborted, true);
  assert.equal(f.inFlight, 1);
  pending.resolve();
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 1, 2]);
  await f.scheduler.tick(5000);
  assert.deepEqual(f.statuses().map(call => call.status), [1, 1, 2, 1]);
  assert.equal(f.configs().length, 2);
});

test('stale getconfig results cannot start typing after stop or a changed context', async t => {
  const first = deferred();
  let attempts = 0;
  const f = fixture(t, { config: () => ++attempts === 1 ? first.promise : 'OFFLINE-NEW-TICKET' });
  f.controller.update('Busy', context);
  await settle();
  f.controller.update('Idle', context);
  f.controller.update('Busy', 'OFFLINE-NEW-CONTEXT');
  assert.equal(f.configs()[0].signal.aborted, true);
  first.resolve('OFFLINE-STALE-TICKET');
  await settle();
  assert.equal(f.statuses().length, 0);
  await f.scheduler.tick(5000);
  assert.deepEqual(f.configs().map(call => call.context), [context, 'OFFLINE-NEW-CONTEXT']);
  assert.deepEqual(f.statuses().map(call => call.ticket), ['OFFLINE-NEW-TICKET']);
});

test('changed Busy context cancels old typing and coalesces rapid context updates', async t => {
  const f = fixture(t, { config: context => `ticket-${context}` });
  f.controller.update('Busy', context);
  await settle();
  for (let i = 0; i < 50; i++) f.controller.update('Busy', `OFFLINE-CONTEXT-${i}`);
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
  assert.equal(f.configs().length, 1);
  await f.scheduler.tick(5000);
  assert.deepEqual(f.configs().map(call => call.context), [context, 'OFFLINE-CONTEXT-49']);
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2, 1]);
  assert.equal(f.statuses()[2].ticket, 'ticket-OFFLINE-CONTEXT-49');
});

test('request timeout aborts a cooperative adapter and retries with bounded backoff', async t => {
  let attempts = 0;
  const f = fixture(t, { config: (_context, signal) => ++attempts === 1
    ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('RAW-PRIVATE-TIMEOUT')), { once: true }))
    : ticket });
  f.controller.update('Busy', context);
  await f.scheduler.tick(2999);
  assert.equal(f.configs()[0].signal.aborted, false);
  await f.scheduler.tick(1);
  assert.equal(f.configs()[0].signal.aborted, true);
  assert.equal(f.logs.length, 1);
  await f.scheduler.tick(4999);
  assert.equal(f.configs().length, 1);
  await f.scheduler.tick(1);
  assert.equal(f.configs().length, 2);
  assert.deepEqual(f.statuses().map(call => call.status), [1]);
});

test('start failures invalidate tickets, cancel possible server acceptance and back off without message effects', async t => {
  let starts = 0;
  const f = fixture(t, { typing: status => {
    if (status === 1 && ++starts <= 5) throw new Error(`RAW-NETWORK ${ticket}`);
  } });
  f.controller.update('Busy', context);
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
  for (const wait of [5000, 10_000, 20_000, 40_000, 60_000]) {
    const before = f.configs().length;
    for (let i = 0; i < 10; i++) {
      f.controller.update('Idle', context);
      f.controller.update('Busy', context);
    }
    await f.scheduler.tick(wait - 1);
    assert.equal(f.configs().length, before);
    await f.scheduler.tick(1);
    assert.equal(f.configs().length, before + 1);
  }
  assert.deepEqual(f.statuses().filter(call => call.status === 1).map(call => call.at), [0, 5000, 15_000, 35_000, 75_000, 135_000]);
  assert.equal(f.logs.length, 2);
  await f.scheduler.tick(5000);
  assert.equal(f.configs().length, 6);
  assert.equal(f.statuses().filter(call => call.status === 1).length, 7);
});

test('missing tickets retry at most once per minute with fixed rate-limited diagnostics', async t => {
  const f = fixture(t, { config: () => undefined });
  f.controller.update('Busy', context);
  await settle();
  assert.equal(f.logs.length, 1);
  for (let i = 0; i < 100; i++) {
    f.controller.update('Idle', context);
    f.controller.update('Busy', `OFFLINE-CONTEXT-${i}`);
  }
  await f.scheduler.tick(59_999);
  assert.equal(f.configs().length, 1);
  assert.equal(f.logs.length, 1);
  await f.scheduler.tick(1);
  assert.equal(f.configs().length, 2);
  assert.equal(f.logs.length, 2);
  assert.equal(f.statuses().length, 0);
  assert.deepEqual([...new Set(f.logs)], ['Weixin typing is unavailable; retrying later.']);
});

test('malformed adapter tickets and throwing diagnostics remain nonfatal', async t => {
  const f = fixture(t, { config: () => 'x'.repeat(8193) }, { log: () => { throw new Error('RAW-LOG-FAILURE'); } });
  assert.doesNotThrow(() => f.controller.update('Busy', context));
  await f.scheduler.tick(5000);
  assert.equal(f.configs().length, 2);
  assert.equal(f.statuses().length, 0);
  await f.controller.dispose();
});

test('cached tickets refresh after a bounded five-minute policy rather than being kept forever', async t => {
  let tickets = 0;
  const f = fixture(t, { config: () => `OFFLINE-TICKET-${++tickets}` });
  f.controller.update('Busy', context);
  await f.scheduler.tick(299_999);
  assert.equal(f.configs().length, 1);
  await f.scheduler.tick(1);
  assert.equal(f.configs().length, 2);
  assert.deepEqual(f.statuses().slice(-2).map(call => [call.status, call.ticket]), [
    [2, 'OFFLINE-TICKET-1'], [1, 'OFFLINE-TICKET-2'],
  ]);
});

test('dispose is idempotent, immediately fences queued startup and clears all scheduled work', async t => {
  const f = fixture(t);
  f.controller.update('Busy', context);
  const disposing = f.controller.dispose();
  assert.equal(f.controller.dispose(), disposing);
  await disposing;
  f.controller.update('Busy', context);
  await f.scheduler.tick(60_000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.scheduler.timers.size, 0);
});

test('dispose during non-cooperative getconfig completes within five seconds and ignores late tickets', async t => {
  const pending = deferred();
  const f = fixture(t, { config: () => pending.promise });
  f.controller.update('Busy', context);
  await settle();
  let done = false;
  const disposing = f.controller.dispose().then(() => { done = true; });
  assert.equal(f.configs()[0].signal.aborted, true);
  await f.scheduler.tick(4999);
  assert.equal(done, false);
  await f.scheduler.tick(1);
  await disposing;
  assert.equal(done, true);
  assert.equal(f.scheduler.timers.size, 0);
  pending.resolve(ticket);
  await settle();
  assert.equal(f.statuses().length, 0);
});

test('bounded disposal still cancels a late start once its non-cooperative request settles', async t => {
  const pending = deferred();
  const f = fixture(t, { typing: status => status === 1 ? pending.promise : undefined });
  f.controller.update('Busy', context);
  await settle();
  const disposing = f.controller.dispose();
  await f.scheduler.tick(5000);
  await disposing;
  assert.equal(f.scheduler.timers.size, 0);
  assert.deepEqual(f.statuses().map(call => call.status), [1]);
  pending.resolve();
  await settle();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
  assert.equal(f.statuses()[1].signal.aborted, false);
  f.controller.update('Busy', context);
  await f.scheduler.tick(20_000);
  assert.equal(f.statuses().length, 2);
});

test('final cancellation has an independent deadline and cannot hold disposal indefinitely', async t => {
  const pending = deferred();
  const f = fixture(t, { typing: status => status === 2 ? pending.promise : undefined });
  f.controller.update('Busy', context);
  await settle();
  const disposing = f.controller.dispose();
  await settle();
  const cancel = f.statuses()[1];
  assert.equal(cancel.status, 2);
  assert.equal(cancel.signal.aborted, false);
  await f.scheduler.tick(2000);
  assert.equal(cancel.signal.aborted, true);
  await f.scheduler.tick(3000);
  await disposing;
  assert.equal(f.scheduler.timers.size, 0);
  pending.reject(new Error('RAW-PRIVATE-LATE-CANCEL'));
  await settle();
  assert.equal(f.scheduler.timers.size, 0);
});

test('a failed best-effort cancel does not reject disposal or restart typing', async t => {
  const f = fixture(t, { typing: status => {
    if (status === 2) throw new Error(`RAW-PRIVATE-CANCEL ${ticket}`);
  } });
  f.controller.update('Busy', context);
  await settle();
  await f.controller.dispose();
  assert.deepEqual(f.statuses().map(call => call.status), [1, 2]);
  assert.equal(f.logs.length, 1);
  assert.equal(f.scheduler.timers.size, 0);
});

test('reconnection acquires its own ticket; old controller timers and updates cannot send new starts', async t => {
  let tickets = 0;
  const f = fixture(t, { config: () => `OFFLINE-CONNECTION-TICKET-${++tickets}` });
  f.controller.update('Busy', context);
  await settle();
  await f.controller.dispose();
  const replacement = new TypingController({ api: f.api, ownerId: owner, log: message => f.logs.push(message), scheduler: f.scheduler });
  t.after(() => replacement.dispose());
  replacement.update('Busy', context);
  f.controller.update('Busy', context);
  await settle();
  await f.scheduler.tick(10_000);
  assert.equal(f.configs().length, 2);
  assert.deepEqual(f.statuses().map(call => [call.status, call.ticket]), [
    [1, 'OFFLINE-CONNECTION-TICKET-1'], [2, 'OFFLINE-CONNECTION-TICKET-1'],
    [1, 'OFFLINE-CONNECTION-TICKET-2'], [1, 'OFFLINE-CONNECTION-TICKET-2'], [1, 'OFFLINE-CONNECTION-TICKET-2'],
  ]);
  await replacement.dispose();
});
