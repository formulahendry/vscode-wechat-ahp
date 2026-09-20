import type { ChatState, Message } from '@microsoft/agent-host-protocol';
import { boundedString, hash, identifier, MAX_PENDING, MAX_RECORDS, MAX_SEEN, MAX_TEXT_BYTES, record, SafeError } from './common.js';
import { bindingKey, type Binding, type Credentials, type StoredMessage, Vault } from './storage.js';
import type { BotApi, Updates } from './weixin.js';
import { MessageEvents, type DeliveryOutcome } from './messageEvents.js';

export const REQUEST_META = 'wechat-ahp/request-id';

type Incoming = { message: Omit<StoredMessage, 'binding' | 'receivedAt' | 'delivery'> } | { dropped: string };

export function incoming(value: unknown, credentials: Credentials): Incoming {
  if (!record(value)) return { dropped: 'malformed message' };
  if (value.from_user_id !== credentials.ownerId || value.from_user_id === credentials.botId) return { dropped: 'unauthorized sender' };
  if (value.to_user_id !== credentials.botId) return { dropped: 'different or missing recipient' };
  if (value.group_id !== undefined && value.group_id !== '') return { dropped: 'group messages are unsupported' };
  if (value.message_type !== 1 || value.message_state !== 2) return { dropped: 'non-user or unfinished message' };
  if (value.delete_time_ms !== undefined && value.delete_time_ms !== 0) return { dropped: 'deleted message' };
  const messageId = typeof value.message_id === 'number' && Number.isSafeInteger(value.message_id) && value.message_id >= 0
    ? String(value.message_id) : value.message_id;
  if (!identifier(messageId)) return { dropped: 'invalid stable message ID' };
  if (!boundedString(value.context_token, 8192)) return { dropped: 'missing private reply context' };
  if (!Array.isArray(value.item_list) || value.item_list.length === 0 || value.item_list.length > 32) {
    return { dropped: 'invalid content list' };
  }
  const texts: string[] = [];
  for (const item of value.item_list) {
    if (!record(item) || item.type !== 1 || !record(item.text_item) || !boundedString(item.text_item.text, MAX_TEXT_BYTES, true)) {
      return { dropped: 'non-text or oversized content' };
    }
    texts.push(item.text_item.text);
  }
  const text = texts.join('\n');
  if (!text.trim() || !boundedString(text, MAX_TEXT_BYTES)) return { dropped: 'empty or oversized text' };
  if (text.includes(credentials.token) || text.includes(value.context_token)) return { dropped: 'text contains a private transport credential' };
  return { message: {
    id: hash(JSON.stringify([credentials.botId, credentials.ownerId, messageId])),
    messageId, text, contextToken: value.context_token,
  } };
}

export function requestId(message: Message | undefined): string | undefined {
  const id = message?._meta?.[REQUEST_META];
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) ? id : undefined;
}

export class Inbox {
  readonly key: string;

  constructor(
    readonly vault: Vault, binding: Binding, readonly api: BotApi, private readonly log: (message: string) => void,
    readonly events = new MessageEvents(),
  ) { this.key = bindingKey(binding); }

  async accept(batch: Updates, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const state = this.vault.snapshot();
    const mapped = batch.msgs.map(value => incoming(value, state.credentials));
    for (const item of mapped) if ('dropped' in item) this.log(`Dropped Weixin message: ${item.dropped}.`);
    if (mapped.every(item => 'dropped' in item) && (!batch.cursor || batch.cursor === state.cursor)) return;
    const received: string[] = [];
    await this.vault.update(next => {
      signal.throwIfAborted();
      for (const item of mapped) {
        if (!('message' in item) || next.seen.includes(item.message.id) || next.messages.some(m => m.id === item.message.id)) continue;
        if (next.messages.filter(m => m.delivery !== 'closed' && m.outbound?.status !== 'sent').length >= MAX_PENDING) {
          throw new SafeError('Private inbox is full (32). No cursor advanced; inspect the bound chat and pending journal.');
        }
        next.messages.push({ ...item.message, binding: this.key, receivedAt: Date.now(), delivery: 'received' });
        received.push(item.message.id);
        next.seen.push(item.message.id);
        next.peer = { binding: this.key, contextToken: item.message.contextToken };
      }
      while (next.messages.length > MAX_RECORDS) {
        const index = next.messages.findIndex(m => m.delivery === 'closed' && m.outbound?.status !== 'sending' && m.outbound?.status !== 'uncertain');
        if (index < 0) throw new SafeError('Private reply journal is full; uncertain send records were preserved.');
        next.messages.splice(index, 1);
      }
      next.seen = next.seen.slice(-MAX_SEEN);
      // Private inbox, immutable route and cursor commit in ONE SecretStorage write.
      if (batch.cursor) next.cursor = batch.cursor;
    });
    for (const id of received) this.events.input('wechatUser', id);
  }

  pending(): StoredMessage[] {
    return this.vault.snapshot().messages.filter(m => m.binding === this.key && m.delivery === 'received');
  }

  containsCredential(text: string): boolean {
    const state = this.vault.snapshot();
    return text.includes(state.credentials.token)
      || !!state.peer?.contextToken && text.includes(state.peer.contextToken)
      || state.messages.some(message => message.contextToken && text.includes(message.contextToken))
      || state.outbox.some(entry => entry.route && text.includes(entry.route.contextToken));
  }

  async recover(state: ChatState): Promise<void> {
    let ambiguous = false;
    const accepted: string[] = [];
    const uncertain: string[] = [];
    await this.vault.update(next => {
      for (const message of next.messages) {
        if (message.binding !== this.key) continue;
        if (message.outbound?.status === 'sending') {
          message.outbound.status = 'uncertain';
          this.log('Interrupted outgoing reply preserved as uncertain; it will NOT be retried.');
        }
        if (message.delivery === 'ambiguous') ambiguous = true;
        if (message.delivery !== 'dispatching') continue;
        const turn = [...state.turns, ...(state.activeTurn ? [state.activeTurn] : [])].find(t => requestId(t.message) === message.id);
        const queued = state.queuedMessages?.find(q => requestId(q.message) === message.id);
        if (turn || queued) {
          message.delivery = 'accepted';
          message.updatedAt = Date.now();
          if (turn) message.turnId = turn.id;
          if (queued) message.queueId = queued.id;
          if (!message.resultRecorded) { message.resultRecorded = true; accepted.push(message.id); }
        } else {
          message.delivery = 'ambiguous';
          ambiguous = true;
          if (!message.resultRecorded) { message.resultRecorded = true; uncertain.push(message.id); }
        }
      }
    });
    for (const id of accepted) this.events.result('wechatUser', id, 'host_accepted');
    for (const id of uncertain) this.events.result('wechatUser', id, 'uncertain');
    if (ambiguous) throw new SafeError('AHP delivery is ambiguous and absent from the retained snapshot. Inspect VS Code, then Clear Pending Journal; nothing was resent.', false, 'ambiguous');
  }

  async markDispatching(id: string, turnId: string | undefined, queueId: string | undefined): Promise<void> {
    await this.vault.update(next => {
      const message = next.messages.find(m => m.id === id && m.binding === this.key);
      if (!message || message.delivery !== 'received') throw new SafeError('Inbound event is no longer pending.');
      message.delivery = 'dispatching';
      message.turnId = turnId;
      message.queueId = queueId;
    });
  }

  async accepted(id: string, turnId?: string): Promise<void> {
    let recordResult = false;
    await this.vault.update(next => {
      const message = next.messages.find(m => m.id === id && m.binding === this.key);
      if (!message) return;
      if (!['dispatching', 'accepted', 'closed'].includes(message.delivery)) throw new SafeError('Unexpected AHP event acknowledgement.');
      if (message.delivery !== 'closed') message.delivery = 'accepted';
      if (turnId) message.turnId = turnId;
      if (!message.resultRecorded) { message.resultRecorded = true; recordResult = true; }
    });
    if (recordResult) this.events.result('wechatUser', id, 'host_accepted');
  }

  async result(id: string, outcome: DeliveryOutcome, error?: unknown): Promise<void> {
    let recordResult = false;
    try {
      await this.vault.update(next => {
        const message = next.messages.find(item => item.id === id && item.binding === this.key);
        if (message && !message.resultRecorded) { message.resultRecorded = true; recordResult = true; }
      });
    } catch {
      recordResult = !this.vault.snapshot().messages.find(item => item.id === id)?.resultRecorded;
      this.log('Could not persist message outcome metadata; channel delivery state was retained.');
    }
    if (recordResult) this.events.result('wechatUser', id, outcome, error);
  }
}
