import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCatalog, SafeError } from '../.test-build/core.mjs';
import { binding, fakeHost, waitFor } from './helpers.mjs';

function catalog(t, host, options = {}) {
  const result = new SessionCatalog({
    assertAllowed() {}, log() {},
    discover: async () => [host.target], resolve: async id => {
      assert.equal(id, host.target.id); return host.target;
    }, ...options,
  });
  t.after(() => result.dispose());
  return result;
}

test('catalog is lazy, paginated and credential-free; browsing never subscribes chat transcripts or dispatches', async t => {
  const host = await fakeHost(t, { catalog: params => ({
    items: [{
      resource: params.cursor ? 'copilotcli:/second' : binding.session,
      title: 'Same title', provider: 'fixture', status: 1,
    }],
    ...(params.cursor ? {} : { nextCursor: 'page-2' }),
  }) });
  const service = catalog(t, host);
  const hosts = await service.children();
  assert.equal(host.methods.length, 0);
  assert.equal(JSON.stringify(hosts).includes(host.target.connectionToken), false);
  const first = await service.children(hosts[0]);
  assert.equal(first.length, 1);
  assert.equal(service.hasMore(hosts[0].hostId), true);
  assert.equal(host.methods.filter(call => call.method === 'subscribe').length, 0);
  await service.loadMore(hosts[0]);
  const sessions = await service.children(hosts[0]);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].id, sessions[1].id);
  assert.equal(service.hasMore(hosts[0].hostId), false);
  const chats = await service.children(sessions[0]);
  assert.equal(chats[0].eligible, true);
  assert.equal(chats[0].resource, binding.chat);
  assert.equal(host.methods.some(call => call.method === 'subscribe' && call.params.channel === binding.chat), false);
  assert.equal(host.actions.length, 0);
  assert.equal((await service.findBinding(binding)).id, chats[0].id);
  await service.ping(hosts[0]);
  assert.ok(host.methods.some(call => call.method === 'ping'));
  assert.equal(host.actions.length, 0);
});

test('catalog retains environment checks and gates binding on readiness/interactivity, not workspace folders', async t => {
  let discovered = false;
  const denied = new SessionCatalog({
    assertAllowed() { throw new SafeError('Remote environments are unsupported.'); }, log() {},
    discover: async () => { discovered = true; return []; },
  });
  t.after(() => denied.dispose());
  const error = await denied.children();
  assert.equal(discovered, false);
  assert.match(error[0].title, /Remote environments/);
  const host = await fakeHost(t);
  host.session.workingDirectories = undefined;
  host.session.chats.push({ ...host.session.chats[0], resource: 'ahp-chat:/readonly', interactivity: 'read-only' });
  const service = catalog(t, host);
  const [hostNode] = await service.children();
  const [session] = await service.children(hostNode);
  const [chat, readOnly] = await service.children(session);
  assert.equal(chat.eligible, true);
  assert.deepEqual(chat.workingDirectories, []);
  assert.equal(readOnly.eligible, false);
  assert.match(readOnly.unavailableReason, /not interactive/);
  host.session.lifecycle = 'creating';
  service.refresh(session);
  assert.match((await service.children(session))[0].title, /not ready/);
  assert.equal(host.actions.length, 0);
});

test('stale discovery cannot restore removed hosts after refresh or disposal', async () => {
  const resolvers = [];
  const service = new SessionCatalog({
    assertAllowed() {}, log() {},
    discover: () => new Promise(resolve => resolvers.push(resolve)),
  });
  const old = service.children();
  service.refresh();
  const fresh = service.children();
  const host = id => ({ id, product: 'Code', pid: 1, protocolVersion: '0.9.0', endpoint: { type: 'tcp' }, connectionToken: 'PRIVATE' });
  resolvers[1]([host('current')]);
  const current = await fresh;
  resolvers[0]([host('old')]);
  assert.deepEqual(await old, []);
  assert.deepEqual((await service.children()).map(node => node.hostId), ['current']);
  assert.equal(service.node(current[0].id).hostId, 'current');
  service.dispose();
  assert.deepEqual(await service.children(), []);
});

test('catalog failures are cached until explicit refresh and never expose raw RPC errors', async t => {
  const host = await fakeHost(t, { rpcError: { method: 'listSessions', code: -32601 } });
  const service = catalog(t, host);
  const [node] = await service.children();
  const error = await service.children(node);
  assert.match(error[0].title, /RPC error \(-32601\)/);
  assert.doesNotMatch(error[0].title, /TEST-SECRET/);
  await service.children(node);
  assert.equal(host.methods.filter(call => call.method === 'listSessions').length, 1);
  service.refresh(node);
  await service.children(node);
  assert.equal(host.methods.filter(call => call.method === 'listSessions').length, 2);
  await waitFor(() => host.clients.length === 0);
});

test('disposing a catalog cancels a pending metadata request and closes its own SDK connection', async t => {
  const host = await fakeHost(t, { ignoreRequests: ['listSessions'] });
  const service = catalog(t, host);
  const [node] = await service.children();
  const pending = service.children(node);
  await waitFor(() => host.methods.some(call => call.method === 'listSessions'));
  service.dispose();
  assert.deepEqual(await pending, []);
  await waitFor(() => host.clients.length === 0);
  assert.equal(host.actions.length, 0);
});
