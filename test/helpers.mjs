import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { chatReducer, sessionReducer, SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol';
import { hash, SECRET_KEY, Vault, WeixinApi } from '../.test-build/core.mjs';

export const credentials = {
  botId: 'test-bot@im.bot', ownerId: 'test-owner@im.wechat',
  token: 'TEST-ONLY-BOT-TOKEN', base: 'https://ilinkai.weixin.qq.com',
};
export const binding = {
  hostId: 'Code:editor:123:test', session: 'ahp-session:/11111111-1111-4111-8111-111111111111',
  chat: 'ahp-chat:/22222222-2222-4222-8222-222222222222', workspace: hash('test-workspace'),
};
export const signal = () => new AbortController().signal;

export function registryFixtureDirectories(root) {
  const segments = process.platform === 'darwin'
    ? ['Library', 'Application Support', 'Code', 'agent-host', 'local-endpoint', 'entries']
    : ['Code', 'agent-host', 'local-endpoint', 'entries'];
  const result = [root];
  for (const segment of segments) result.push(join(result.at(-1), segment));
  return result;
}

export function registryEnvironment(root) {
  const previous = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.APPDATA = root;
  process.env.XDG_CONFIG_HOME = root;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function mockOsForTests(original, home) {
  return {
    ...original, homedir: () => home,
    userInfo: () => ({ ...original.userInfo(), homedir: home, uid: Number.parseInt(hash(home).slice(0, 7), 16) }),
  };
}
export const waitFor = async (predicate, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Condition did not become true');
    await sleep(5);
  }
};
export function message(id = '1', text = 'Use the existing context marker', extra = {}) {
  return {
    message_id: id, from_user_id: credentials.ownerId, to_user_id: credentials.botId,
    message_type: 1, message_state: 2, context_token: `TEST-PRIVATE-CONTEXT-${id}`,
    item_list: [{ type: 1, text_item: { text } }], ...extra,
  };
}
export class MemorySecrets {
  data = new Map();
  writes = [];
  fail = false;
  async get(key) { return this.data.get(key); }
  async store(key, value) {
    if (this.fail) throw new Error('TEST-SECRET-MUST-NOT-LEAK');
    this.writes.push({ key, value });
    this.data.set(key, value);
  }
  async delete(key) { this.data.delete(key); }
  state() { return JSON.parse(this.data.get(SECRET_KEY)); }
}
export async function vault() {
  const secrets = new MemorySecrets();
  return { secrets, vault: await Vault.create(secrets, credentials) };
}
export function chatState() {
  return {
    resource: binding.chat, title: 'Existing chat', status: 1, modifiedAt: new Date(0).toISOString(),
    turns: [{
      id: randomUUID(), state: 'complete', startedAt: new Date(0).toISOString(), duration: 0,
      message: { origin: { kind: 'user' }, text: 'The unique preexisting context marker is BLUE-PANDA.' },
      responseParts: [],
    }],
  };
}
export async function fakeHost(t, options = {}) {
  const resources = options.resources ?? binding;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map();
  const httpRequests = [];
  const methods = [];
  const actions = [];
  const envelopes = [];
  let seq = 0;
  let state = { ...chatState(), resource: resources.chat };
  let session = {
    lifecycle: 'ready', provider: 'fixture-provider', title: 'Existing session', status: 1,
    activeClients: [], chats: [{ resource: resources.chat, title: 'Existing chat', status: 1, modifiedAt: new Date(0).toISOString() }],
    defaultChat: resources.chat, workingDirectories: [pathToFileURL(process.cwd()).href],
  };
  const host = {
    get state() { return state; },
    get session() { return session; },
    get clients() { return [...sockets.values()]; },
    methods, actions, envelopes, httpRequests,
    ignoreAck: undefined, reject: undefined,
    emit(action, channel = resources.chat, origin, overrideSeq) {
      if (channel === resources.chat) state = chatReducer(state, action);
      else if (channel === resources.session) session = sessionReducer(session, action);
      const envelope = { channel, action, serverSeq: overrideSeq ?? ++seq, ...(origin ? { origin } : {}) };
      envelopes.push(envelope);
      for (const [socket, info] of sockets) if (info.subs.has(channel) && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: envelope }));
      }
      return envelope;
    },
    repeat(envelope) {
      for (const socket of sockets.keys()) socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: envelope }));
    },
    disconnect() { for (const socket of sockets.keys()) socket.terminate(); },
    tool({ text = 'BLUE-PANDA', requestId, confirmed = 'not-needed', contributor, input, turnId } = {}) {
      const active = state.activeTurn;
      const turn = turnId ?? active?.id;
      const toolCallId = randomUUID();
      host.emit({
        type: 'chat/toolCallStart', turnId: turn, toolCallId, toolName: 'wechat_ahp_reply', displayName: 'Reply',
        contributor: contributor ?? { kind: 'client', clientId: host.clients.at(-1)?.clientId },
      });
      const ready = host.emit({
        type: 'chat/toolCallReady', turnId: turn, toolCallId, invocationMessage: 'Send reply',
        toolInput: input ?? JSON.stringify({ request_id: requestId ?? active?.message?._meta?.['wechat-ahp/request-id'], text }),
        ...(confirmed === null ? {} : { confirmed }),
      });
      return { turn, toolCallId, ready };
    },
    completeTurn() {
      if (state.activeTurn) host.emit({ type: 'chat/turnComplete', turnId: state.activeTurn.id, duration: 1 });
    },
    answer(text = 'BLUE-PANDA') {
      host.emit({ type: 'chat/responsePart', turnId: state.activeTurn.id, part: { kind: 'markdown', id: randomUUID(), content: text } });
      host.completeTurn();
    },
    startEditorTurn(text = 'An unrelated editor message') {
      host.emit({ type: 'chat/turnStarted', turnId: randomUUID(), startedAt: new Date().toISOString(), message: { origin: { kind: 'user' }, text } });
    },
    dequeue() {
      const queued = state.queuedMessages?.[0];
      if (queued) host.emit({
        type: 'chat/turnStarted', turnId: randomUUID(), queuedMessageId: queued.id,
        startedAt: new Date().toISOString(), message: queued.message,
      });
    },
  };
  if (options.busy) host.startEditorTurn();
  server.on('upgrade', (request, socket, head) => {
    httpRequests.push(request.url);
    if (new URL(request.url, 'http://localhost').searchParams.get('tkn') !== 'TEST-ONLY-AHP-TOKEN') {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    const info = { clientId: undefined, subs: new Set() };
    sockets.set(socket, info);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', buffer => {
      const request = JSON.parse(buffer.toString());
      methods.push(request);
      const p = request.params;
      const reply = result => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      if (options.ignoreRequests?.includes(request.method)) return;
      if (options.rpcError?.method === request.method) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
          code: options.rpcError.code, message: 'TEST-SECRET-RAW-RPC-MESSAGE', data: { token: 'TEST-SECRET-RPC-DATA' },
        } }));
        return;
      }
      if (request.method === 'initialize') {
        info.clientId = p.clientId;
        for (const uri of p.initialSubscriptions ?? []) info.subs.add(uri);
        reply({
          protocolVersion: options.protocolVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0], serverSeq: seq,
          snapshots: [{ resource: 'ahp-root://', state: { agents: [], activeSessions: [] }, fromSeq: seq }],
        });
      } else if (request.method === 'listSessions') reply(typeof options.catalog === 'function' ? options.catalog(p) : options.catalog ?? {
        items: [{
          resource: resources.session, provider: session.provider, title: session.title, status: 1,
          createdAt: new Date(0).toISOString(), modifiedAt: new Date(0).toISOString(),
        }],
      });
      else if (request.method === 'subscribe') {
        info.subs.add(p.channel);
        const snapshot = { resource: p.channel, state: p.channel === resources.chat ? state : session, fromSeq: seq };
        reply(options.missingSnapshot ? {} : { snapshot });
      } else if (request.method === 'unsubscribe') info.subs.delete(p.channel);
      else if (request.method === 'ping') reply({});
      else if (request.method === 'resourceRead') reply({ encoding: 'utf-8', data: options.resourceInput ?? '{}' });
      else if (request.method === 'dispatchAction') {
        actions.push({ ...p, clientId: info.clientId });
        const origin = { clientId: info.clientId, clientSeq: p.clientSeq };
        if (host.reject === p.action.type) {
          socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'action', params: {
            ...p, origin, serverSeq: ++seq, rejectionReason: 'TEST-SECRET-RAW-REJECTION',
          } }));
        } else if (host.ignoreAck === p.action.type) {
          if (p.channel === resources.chat) state = chatReducer(state, p.action);
        } else host.emit(p.action, p.channel, origin);
      } else if (request.id !== undefined) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown fixture method' } }));
      }
    });
  });
  let socketDirectory;
  if (options.pipe && process.platform === 'win32') server.listen(`\\\\.\\pipe\\wechat-ahp-test-${randomUUID()}`);
  else if (options.pipe) {
    socketDirectory = await mkdtemp(join(tmpdir(), 'wahp-'));
    server.listen(join(socketDirectory, 'host.sock'));
  } else server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  host.target = {
    id: resources.hostId, product: 'Code', pid: process.pid, protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
    connectionToken: 'TEST-ONLY-AHP-TOKEN',
    endpoint: typeof address === 'string' ? { type: 'socket', path: address } : { type: 'tcp', host: '127.0.0.1', port: address.port },
  };
  t.after(async () => {
    for (const socket of sockets.keys()) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    if (socketDirectory) await rmdir(socketDirectory);
  });
  return host;
}

export async function fakeWeixin(t, batches = [], sendResponse = { ret: 0 }) {
  const sends = [];
  const polls = [];
  const requests = [];
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : undefined;
    requests.push({ path: request.url, headers: request.headers, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/ilink/bot/getupdates') {
      polls.push(body);
      response.end(JSON.stringify(batches.shift() ?? { ret: 0, msgs: [] }));
    } else if (request.url === '/ilink/bot/sendmessage') {
      sends.push(body.msg);
      response.end(JSON.stringify(sendResponse));
    } else { response.statusCode = 404; response.end('{"ret":-1}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = new WeixinApi(credentials.base, credentials.token, (url, options) => {
    const source = new URL(url);
    if (source.origin !== credentials.base) throw new Error('Unexpected external host in test');
    return fetch(`${base}${source.pathname}${source.search}`, options);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { api, sends, polls, requests, batches };
}
