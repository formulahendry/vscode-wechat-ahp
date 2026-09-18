import { randomUUID } from 'node:crypto';
import { MessageKind, ResponsePartKind, TurnState, type ChatState, type Message, type Turn, type ActiveTurn } from '@microsoft/agent-host-protocol';
import { boundedString, diagnostic, hash, MAX_SEEN, MAX_TEXT_BYTES, SafeError } from './common.js';
import { Inbox, requestId } from './inbox.js';
import type { PrivateState, ReplyRoute, SyncTurn } from './storage.js';
import { presentMessage } from './messagePresentation.js';

export function visibleText(turn: Turn | ActiveTurn): string {
  let text = '';
  for (const part of turn.responseParts) {
    if (part.kind !== ResponsePartKind.Markdown) continue;
    if (!boundedString(part.content, MAX_TEXT_BYTES, true) || Buffer.byteLength(text) + Buffer.byteLength(part.content) > MAX_TEXT_BYTES) {
      throw new SafeError('Assistant text exceeds the 16 KiB sync limit. Nothing was truncated or sent.');
    }
    text += part.content;
  }
  return text;
}

export class TextSync {
  constructor(
    readonly inbox: Inbox, readonly runId: string, private readonly log: (message: string) => void,
    private readonly blockedText: (text: string) => boolean,
  ) {}

  async open(snapshot: ChatState): Promise<void> {
    let resumed = false;
    await this.inbox.vault.update(next => {
      resumed = next.sync?.binding === this.inbox.key && next.sync.runId === this.runId;
      if (!resumed) {
        const abandoned = next.outbox.filter(entry => ['pending', 'waiting', 'sending'].includes(entry.status)).length;
        for (const entry of next.outbox) {
          if (entry.status === 'sending') entry.status = 'uncertain';
          if (entry.status === 'pending' || entry.status === 'waiting') entry.status = 'cancelled';
          entry.text = '';
          entry.route = undefined;
          entry.parts = undefined;
        }
        next.sync = { binding: this.inbox.key, runId: this.runId, turns: [], seen: [] };
        if (abandoned) this.log(`Previous sync run left ${abandoned} unfinished send(s). They were closed without replay; inspect the original chat and WeChat.`);
        // Use only a previously authenticated peer from this exact binding.
        if (next.peer?.binding !== this.inbox.key) {
          const previous = next.messages.filter(message => message.binding === this.inbox.key && message.contextToken).at(-1);
          next.peer = previous ? { binding: this.inbox.key, contextToken: previous.contextToken } : undefined;
        }
      } else {
        for (const entry of next.outbox) if (entry.status === 'sending') {
          entry.status = 'uncertain';
          entry.text = '';
          entry.route = undefined;
          entry.parts = undefined;
          this.log('Interrupted sync send is uncertain; it will NOT be retried.');
        }
      }
      const sync = this.session(next);
      const existingIds = [
        ...snapshot.turns.map(turn => turn.id),
        ...(snapshot.activeTurn ? [snapshot.activeTurn.id] : []),
        ...(snapshot.queuedMessages ?? []).map(entry => entry.id),
      ];
      sync.seen = [...new Set([...sync.seen, ...existingIds.map(hash)])].slice(-MAX_SEEN);
    });
    if (resumed) {
      await this.inbox.vault.update(next => {
        const sync = this.session(next);
        for (const turn of [...snapshot.turns, ...(snapshot.activeTurn ? [snapshot.activeTurn] : [])]) {
          const request = requestId(turn.message);
          if (!request) continue;
          const tracked = sync.turns.find(item => item.requestId === request);
          if (tracked && !tracked.turnId) tracked.turnId = turn.id;
        }
      });
      for (const turn of snapshot.turns) {
        if (turn.state === TurnState.Complete) await this.complete(turn);
        else await this.cancel(turn.id);
      }
      this.log('Reconnected: tracked turns recovered from the snapshot. New editor messages while disconnected are not backfilled.');
    } else this.log('Two-way text sync enabled for NEW messages in the bound chat; existing history/active turns are not copied.');
    await this.refreshRoute();
  }

  private session(state: PrivateState) {
    if (!state.sync || state.sync.binding !== this.inbox.key || state.sync.runId !== this.runId) {
      throw new SafeError('Text sync binding changed; old messages will not be rerouted.');
    }
    return state.sync;
  }

  private route(next: PrivateState): ReplyRoute | undefined {
    return next.peer?.binding === this.inbox.key ? { contextToken: next.peer.contextToken } : undefined;
  }

  private safeText(text: string): void {
    if (!boundedString(text, MAX_TEXT_BYTES, true)) throw new SafeError('Text exceeds the 16 KiB sync limit.');
    if (this.blockedText(text) || this.inbox.containsCredential(text)) throw new SafeError('Text sync blocked a known transport credential.');
  }

  async started(turnId: string, message: Message, queueId?: string): Promise<void> {
    await this.track(turnId, message, queueId);
  }

  async queued(queueId: string, message: Message): Promise<void> {
    await this.track(undefined, message, queueId);
  }

  async steering(id: string, message: Message): Promise<void> {
    await this.track(undefined, message, id);
    await this.inbox.vault.update(next => {
      const turn = this.session(next).turns.find(item => item.queueId === id);
      // Steering is visible user input, not a second assistant turn.
      if (turn) turn.complete = true;
    });
  }

  private async track(turnId: string | undefined, message: Message, queueId?: string): Promise<void> {
    if (message.origin.kind !== MessageKind.User) return;
    this.safeText(message.text);
    await this.inbox.vault.update(next => {
      const sync = this.session(next);
      const existing = sync.turns.find(turn => turn.turnId === turnId && turnId !== undefined
        || turn.queueId === queueId && queueId !== undefined);
      if (existing) {
        if (turnId && !existing.turnId) { existing.turnId = turnId; existing.complete = false; }
        return;
      }
      const sourceId = queueId ?? turnId;
      if (!sourceId) throw new SafeError('Missing source identity for text sync.');
      const key = hash(sourceId);
      if (sync.seen.includes(key)) return;
      const requested = requestId(message);
      const source = next.messages.find(incoming => incoming.id === requested && incoming.binding === this.inbox.key
        && (incoming.turnId === turnId && turnId !== undefined || incoming.queueId === queueId && queueId !== undefined));
      if (requested && !source) {
        this.log('Ignored an uncorrelated channel marker; it is not authority to send messages.');
        return;
      }
      if (sync.turns.length >= 128) {
        const index = sync.turns.findIndex(turn => turn.complete);
        if (index < 0) throw new SafeError('Too many unfinished sync turns (128); channel stopped without dropping new messages.');
        sync.turns.splice(index, 1);
      }
      const turn: SyncTurn = {
        sourceId, turnId, queueId, requestId: source?.id,
        route: source?.contextToken ? { contextToken: source.contextToken } : this.route(next), complete: false,
      };
      sync.turns.push(turn);
      sync.seen = [...sync.seen, key].slice(-MAX_SEEN);
      if (!source) this.enqueue(next, turn, 'user', message.text);
      else if (turnId && source.delivery !== 'closed') {
        source.turnId = turnId;
      }
    });
  }

  private enqueue(next: PrivateState, turn: SyncTurn, role: 'user' | 'assistant', text: string): void {
    if (!text.trim()) return;
    const id = hash(JSON.stringify([this.inbox.key, turn.sourceId, role]));
    if (next.outbox.some(entry => entry.id === id)) return;
    if (next.outbox.length >= 256) {
      const index = next.outbox.findIndex(entry => entry.status === 'sent' || entry.status === 'cancelled');
      if (index < 0) throw new SafeError('Text outbox is full (256); uncertain sends were preserved.');
      next.outbox.splice(index, 1);
    }
    next.outbox.push({
      id, binding: this.inbox.key, runId: this.runId, sourceId: turn.sourceId, role, text,
      route: turn.route, status: turn.route ? 'pending' : 'waiting', sent: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    if (!turn.route) this.log('Text sync is waiting for a WeChat message from the authorized owner to establish reply context.');
  }

  async complete(turn: Turn | ActiveTurn): Promise<void> {
    const tracked = this.inbox.vault.snapshot().sync?.turns.find(item => item.turnId === turn.id && !item.complete);
    if (!tracked) return;
    const text = visibleText(turn);
    this.safeText(text);
    await this.inbox.vault.update(next => {
      const record = this.session(next).turns.find(item => item.turnId === turn.id);
      if (!record || record.complete) return;
      const incoming = next.messages.find(message => message.id === record.requestId);
      // A legacy reply attempt may already have delivered; never send it a second time.
      if (!incoming?.outbound) this.enqueue(next, record, 'assistant', text);
      else this.log('Legacy reply attempt preserved; its final text was not resent.');
      record.complete = true;
      if (incoming) { incoming.delivery = 'closed'; incoming.text = ''; incoming.contextToken = ''; }
    });
  }

  async cancel(turnId: string, queueId?: string): Promise<void> {
    await this.inbox.vault.update(next => {
      const turn = this.session(next).turns.find(item => item.turnId === turnId || queueId !== undefined && item.queueId === queueId);
      if (!turn || turn.complete) return;
      turn.complete = true;
      const incoming = next.messages.find(message => message.id === turn.requestId);
      if (incoming) { incoming.delivery = 'closed'; incoming.text = ''; incoming.contextToken = ''; }
    });
  }

  async refreshRoute(): Promise<void> {
    const state = this.inbox.vault.snapshot();
    if (!this.route(state) || !state.outbox.some(entry => entry.binding === this.inbox.key && entry.runId === this.runId && entry.status === 'waiting')) return;
    await this.inbox.vault.update(next => {
      const route = this.route(next);
      if (!route) return;
      for (const turn of this.session(next).turns) if (!turn.route) turn.route = route;
      for (const entry of next.outbox) if (entry.binding === this.inbox.key && entry.runId === this.runId && entry.status === 'waiting') {
        entry.route = route;
        entry.status = 'pending';
      }
    });
  }

  async flush(signal: AbortSignal): Promise<void> {
    await this.refreshRoute();
    for (const entry of this.inbox.vault.snapshot().outbox) {
      signal.throwIfAborted();
      if (entry.binding !== this.inbox.key || entry.runId !== this.runId || entry.status !== 'pending' || !entry.route) continue;
      this.safeText(entry.text);
      const parts = entry.parts ?? presentMessage(entry.role, entry.text);
      await this.inbox.vault.update(next => {
        this.session(next);
        const current = next.outbox.find(item => item.id === entry.id);
        if (!current || current.status !== 'pending') throw new SafeError('Sync send is no longer pending.');
        signal.throwIfAborted();
        current.status = 'sending';
        current.parts = parts;
        current.updatedAt = Date.now();
      });
      const owner = this.inbox.vault.snapshot().credentials.ownerId;
      for (const [index, text] of parts.entries()) {
        try {
          signal.throwIfAborted();
          await this.inbox.api.send({
            from_user_id: '', to_user_id: owner, client_id: randomUUID(),
            message_type: 2, message_state: 2, context_token: entry.route.contextToken,
            item_list: [{ type: 1, text_item: { text } }],
          }, signal);
        } catch (error) {
          await this.inbox.vault.update(next => {
            const current = next.outbox.find(item => item.id === entry.id);
            if (current) {
              current.status = 'uncertain'; current.text = ''; current.route = undefined; current.parts = undefined;
              current.updatedAt = Date.now();
            }
          });
          signal.throwIfAborted();
          throw new SafeError(`WeChat text sync stopped after ${index}/${parts.length} confirmed parts. Do not resend automatically. ${diagnostic(error)}`,
            false, error instanceof SafeError && error.kind === 'auth' ? 'auth' : 'delivery');
        }
        await this.inbox.vault.update(next => {
          const current = next.outbox.find(item => item.id === entry.id);
          if (!current || current.status !== 'sending') throw new SafeError('Missing durable sync send record.');
          current.sent = index + 1;
          current.updatedAt = Date.now();
          if (index === parts.length - 1) {
            current.status = 'sent'; current.text = ''; current.route = undefined; current.parts = undefined;
          }
        });
      }
      this.log(entry.role === 'user' ? 'VS Code user text accepted by Weixin.' : 'Completed assistant text accepted by Weixin.');
    }
  }
}
