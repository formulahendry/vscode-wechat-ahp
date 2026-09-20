import { randomBytes } from 'node:crypto';
import { parse } from 'lossless-json';
import { apiBase, boundedString, DEFAULT_BASE, identifier, record, SafeError, VERSION, withAbort } from './common.js';

export interface Updates {
  msgs: unknown[];
  cursor?: string;
}

export interface SendMessage {
  from_user_id: '';
  to_user_id: string;
  client_id: string;
  message_type: 2;
  message_state: 2;
  context_token: string;
  item_list: { type: 1; text_item: { text: string } }[];
}

export interface BotApi {
  updates(cursor: string, signal: AbortSignal): Promise<Updates>;
  send(message: SendMessage, signal: AbortSignal): Promise<void>;
  getTypingTicket?(ownerId: string, contextToken: string, signal: AbortSignal): Promise<string | undefined>;
  sendTyping?(ownerId: string, ticket: string, status: 1 | 2, signal: AbortSignal): Promise<void>;
}

export function parseWire(text: string): unknown {
  // Preserve uint64 message IDs without depending on JSON reviver source support.
  return parse(text, undefined, source => {
    const value = Number(source);
    return /^-?\d+$/.test(source) && !Number.isSafeInteger(value) ? source : value;
  });
}

export function checkBusiness(value: Record<string, unknown>): void {
  for (const key of ['ret', 'errcode']) {
    const code = value[key];
    if (code === undefined || code === 0) continue;
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
      throw new SafeError('Malformed Weixin business status.', false, 'protocol');
    }
    if (code === -14) throw new SafeError('Weixin credentials expired (-14). Sign in with QR again.', false, 'auth');
    throw new SafeError(`Weixin business error (${key}=${code}).`, false, 'business');
  }
}

export class WeixinApi implements BotApi {
  readonly base: string;

  constructor(base = DEFAULT_BASE, private readonly token?: string, private readonly fetcher = fetch) {
    this.base = apiBase(base);
  }

  async request(
    endpoint: string, body: Record<string, unknown> | undefined, signal: AbortSignal, timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    if (!/^ilink\/bot\/[a-z_]+(?:\?[^#]*)?$/.test(endpoint)) {
      throw new SafeError('Invalid internal Weixin endpoint.');
    }
    signal.throwIfAborted();
    const version = VERSION.split('.').map(Number);
    const clientVersion = ((version[0]! & 0xff) << 16) | ((version[1]! & 0xff) << 8) | (version[2]! & 0xff);
    const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(clientVersion) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    const allowEmpty = endpoint === 'ilink/bot/sendtyping' && body !== undefined;
    try {
      const response = await withAbort(this.fetcher(`${this.base}/${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal, redirect: 'error',
      }), requestSignal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) {
          throw new SafeError('Weixin authorization failed. Sign in with QR again.', false, 'auth');
        }
        throw new SafeError(`Weixin HTTP ${response.status}.`, response.status === 429 || response.status >= 500, 'http');
      }
      if (!response.body) {
        if (allowEmpty) return {};
        throw new SafeError('Empty Weixin response.', false, 'protocol');
      }
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await withAbort(reader.read(), requestSignal);
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 1024 * 1024) throw new SafeError('Weixin response exceeds 1 MiB.', false, 'protocol');
          parts.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      if (allowEmpty && length === 0) return {};
      let value: unknown;
      try { value = parseWire(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); }
      catch { throw new SafeError('Malformed Weixin JSON.', false, 'protocol'); }
      if (!record(value)) throw new SafeError('Expected a Weixin response object.', false, 'protocol');
      checkBusiness(value);
      return value;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SafeError) throw error;
      if (timeout.aborted) throw new SafeError('Weixin request timed out.', true, 'timeout');
      throw new SafeError('Weixin network/TLS request failed (HTTP redirects are disabled).', true, 'network');
    }
  }

  async updates(cursor: string, signal: AbortSignal): Promise<Updates> {
    const response = await this.request('ilink/bot/getupdates', {
      get_updates_buf: cursor, base_info: baseInfo(),
    }, signal, 40_000);
    if (response.ret !== 0 && response.errcode !== 0 && !Array.isArray(response.msgs)) {
      throw new SafeError('getupdates did not report success or a message list.', false, 'protocol');
    }
    if (response.msgs !== undefined && (!Array.isArray(response.msgs) || response.msgs.length > 200)) {
      throw new SafeError('Invalid or oversized Weixin batch.', false, 'protocol');
    }
    if (response.get_updates_buf !== undefined && !boundedString(response.get_updates_buf, 64 * 1024, true)) {
      throw new SafeError('Invalid Weixin polling cursor.', false, 'protocol');
    }
    return {
      msgs: Array.isArray(response.msgs) ? response.msgs : [],
      ...(typeof response.get_updates_buf === 'string' && response.get_updates_buf ? { cursor: response.get_updates_buf } : {}),
    };
  }

  async send(msg: SendMessage, signal: AbortSignal): Promise<void> {
    // Tencent's sendMessage client permits omitted ret on successful HTTP + JSON.
    // request still rejects malformed JSON, HTTP failures and every nonzero business code.
    await this.request('ilink/bot/sendmessage', { msg, base_info: baseInfo() }, signal);
  }

  async getTypingTicket(ownerId: string, contextToken: string, signal: AbortSignal): Promise<string | undefined> {
    if (!identifier(ownerId) || !boundedString(contextToken, 8192) || !contextToken.trim()) {
      throw new SafeError('Invalid Weixin typing recipient or context.', false, 'protocol');
    }
    const response = await this.request('ilink/bot/getconfig', {
      ilink_user_id: ownerId, context_token: contextToken, base_info: baseInfo(),
    }, signal, 3000);
    if (response.ret !== 0) {
      throw new SafeError('Weixin typing configuration did not report success.', false, 'protocol');
    }
    if (response.typing_ticket === undefined) return undefined;
    if (!boundedString(response.typing_ticket, 8192) || !response.typing_ticket.trim()) {
      throw new SafeError('Invalid Weixin typing ticket.', false, 'protocol');
    }
    return response.typing_ticket;
  }

  async sendTyping(ownerId: string, ticket: string, status: 1 | 2, signal: AbortSignal): Promise<void> {
    if (!identifier(ownerId) || !boundedString(ticket, 8192) || !ticket.trim() || (status !== 1 && status !== 2)) {
      throw new SafeError('Invalid Weixin typing request.', false, 'protocol');
    }
    await this.request('ilink/bot/sendtyping', {
      ilink_user_id: ownerId, typing_ticket: ticket, status, base_info: baseInfo(),
    }, signal, 3000);
  }
}

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: VERSION, bot_agent: `WechatAHP-VSCode/${VERSION}` };
}
