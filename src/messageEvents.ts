import { MAX_SEEN, SafeError } from './common.js';
import type { PrivateState } from './storage.js';

export type UserSource = 'wechatUser' | 'vscodeUser';
export type MessageSource = UserSource | 'agentReply';
export type DeliveryOutcome = 'host_accepted' | 'api_accepted' | 'failed' | 'uncertain' | 'cancelled';
export interface MessageObserver {
  input(source: UserSource): void;
  completed(hasReply: boolean): void;
  result(source: MessageSource, outcome: DeliveryOutcome, error?: unknown): void;
}
export interface DeliveryResult {
  source: MessageSource;
  id: string;
  outcome: DeliveryOutcome;
}

export class MessageEvents {
  private readonly seen = new Map<string, true>();
  private warned = false;

  constructor(private readonly observer?: MessageObserver, private readonly log: (message: string) => void = () => {}) {}

  private once(key: string, work: (observer: MessageObserver) => void): void {
    if (this.seen.has(key)) return;
    this.seen.set(key, true);
    if (this.seen.size > MAX_SEEN * 3) this.seen.delete(this.seen.keys().next().value!);
    try { if (this.observer) work(this.observer); }
    catch {
      if (!this.warned) { this.warned = true; this.log('Message telemetry is unavailable; channel operation is unaffected.'); }
    }
  }

  input(source: UserSource, id: string): void { this.once(`input:${source}:${id}`, observer => observer.input(source)); }
  completed(id: string, hasReply: boolean): void { this.once(`complete:${id}`, observer => observer.completed(hasReply)); }
  result(source: MessageSource, id: string, outcome: DeliveryOutcome, error?: unknown): void {
    this.once(`result:${source}:${id}`, observer => observer.result(source, outcome, error));
  }
  results(results: DeliveryResult[], error?: unknown): void {
    for (const result of results) this.result(result.source, result.id, result.outcome, error);
  }
}

// Marks resolved journal transitions even when usage telemetry is disabled.
// The journal is not a telemetry queue and these flags are never replayed.
export function closingResults(state: PrivateState, binding?: string, clearReceived = false): DeliveryResult[] {
  const results: DeliveryResult[] = [];
  for (const message of state.messages) {
    if (binding && message.binding !== binding || message.resultRecorded || message.outbound) continue;
    const outcome = message.delivery === 'dispatching' || message.delivery === 'ambiguous' ? 'uncertain'
      : message.delivery === 'accepted' ? 'host_accepted'
      : clearReceived && message.delivery === 'received' ? 'cancelled' : undefined;
    if (outcome) {
      message.resultRecorded = true;
      results.push({ source: 'wechatUser', id: message.id, outcome });
    }
  }
  for (const entry of state.outbox) {
    if (binding && entry.binding !== binding || entry.role === 'status' || entry.resultRecorded) continue;
    const outcome = entry.status === 'sending' ? 'uncertain'
      : entry.status === 'pending' || entry.status === 'waiting' ? 'cancelled' : undefined;
    if (outcome) {
      entry.resultRecorded = true;
      results.push({ source: entry.role === 'user' ? 'vscodeUser' : 'agentReply', id: entry.id, outcome });
    }
  }
  return results;
}

export const STORAGE_RESULT_ERROR = () => new SafeError('Delivery state could not be persisted.', false, 'storage');
