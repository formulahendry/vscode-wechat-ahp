import { boundedString, identifier } from './common.js';
import type { AgentStatus } from './channelState.js';
import type { BotApi } from './weixin.js';

// Tencent's reference client uses 5 seconds; this is not a server TTL guarantee.
const KEEPALIVE_MS = 5000;
const REQUEST_MS = 3000;
const CANCEL_MS = 2000;
const DISPOSE_MS = 5000;
const TICKET_MS = 5 * 60_000;
const BACKOFF_MS = 60_000;
const DIAGNOSTIC_MS = 60_000;

export interface TypingScheduler {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface TypingOptions {
  api: BotApi;
  ownerId: string;
  log(message: string): void;
  scheduler?: TypingScheduler;
}

interface Ticket {
  value: string;
  context: string;
  expires: number;
}

interface Request {
  controller: AbortController;
  timer: unknown;
  kind: 'config' | 'start' | 'cancel';
}

type Result<T> = { ok: true; value: T } | { ok: false };

const defaultScheduler: TypingScheduler = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class TypingController {
  private readonly scheduler: TypingScheduler;
  private readonly enabled: boolean;
  private desiredContext?: string;
  private generation = 0;
  private ticket?: Ticket;
  private activeTicket?: string;
  private cancelNeeded = false;
  private resetKeepaliveAfterStop = false;
  private request?: Request;
  private work?: Promise<void>;
  private dirty = false;
  private wakeTimer?: unknown;
  private nextStart = 0;
  private nextConfig = 0;
  private retryAt = 0;
  private failures = 0;
  private lastDiagnostic = -Infinity;
  private disposed = false;
  private disposal?: Promise<void>;
  private disposalTimer?: unknown;
  private resolveDisposal?: () => void;

  constructor(private readonly options: TypingOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.enabled = identifier(options.ownerId)
      && typeof options.api.getTypingTicket === 'function' && typeof options.api.sendTyping === 'function';
  }

  update(agent: AgentStatus, contextToken?: string): void {
    if (this.disposed || !this.enabled) return;
    const context = agent === 'Busy' && boundedString(contextToken, 8192) && contextToken.trim()
      ? contextToken : undefined;
    if (context === this.desiredContext) return;
    this.desiredContext = context;
    if (context === undefined) this.resetKeepaliveAfterStop = true;
    this.generation++;
    this.clearWake();
    if (context !== undefined && this.ticket?.context !== context) this.ticket = undefined;
    this.cancelNeeded = this.activeTicket !== undefined;
    if (this.request?.kind !== 'cancel') this.request?.controller.abort();
    this.kick();
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.desiredContext = undefined;
    this.generation++;
    this.ticket = undefined;
    this.clearWake();
    this.cancelNeeded = this.activeTicket !== undefined;
    if (this.request?.kind !== 'cancel') this.request?.controller.abort();
    this.disposal = new Promise(resolve => { this.resolveDisposal = resolve; });
    this.disposalTimer = this.scheduler.setTimeout(() => this.finishDisposal(), DISPOSE_MS);
    this.kick();
    return this.disposal;
  }

  private kick(): void {
    this.dirty = true;
    if (this.work) return;
    this.work = Promise.resolve().then(async () => {
      do {
        this.dirty = false;
        await this.drain();
      } while (this.dirty);
    }).catch(() => {
      this.report('Weixin typing is unavailable; message syncing is unaffected.');
    }).finally(() => {
      this.work = undefined;
      if (this.dirty) this.kick();
      else if (this.disposed && !this.activeTicket && !this.request) this.finishDisposal();
    });
  }

  private async drain(): Promise<void> {
    while (true) {
      if (this.cancelNeeded && this.activeTicket) {
        const ticket = this.activeTicket;
        this.cancelNeeded = false;
        const result = await this.call('cancel', signal => this.options.api.sendTyping!(this.options.ownerId, ticket, 2, signal));
        this.activeTicket = undefined;
        this.cancelNeeded = false;
        if (result.ok && this.resetKeepaliveAfterStop) this.nextStart = 0;
        this.resetKeepaliveAfterStop = false;
        if (!result.ok) this.report('Weixin typing cancellation failed; indicator cleanup is best effort.');
        continue;
      }
      if (this.disposed || !this.desiredContext) return;
      const now = this.scheduler.now();
      if (this.ticket && (this.ticket.expires <= now || this.ticket.context !== this.desiredContext)) {
        this.ticket = undefined;
        this.cancelNeeded = this.activeTicket !== undefined;
        continue;
      }
      const readyAt = Math.max(this.retryAt, this.nextStart, this.ticket ? 0 : this.nextConfig);
      if (readyAt > now) {
        this.clearWake();
        this.wakeTimer = this.scheduler.setTimeout(() => {
          this.wakeTimer = undefined;
          this.kick();
        }, readyAt - now);
        return;
      }
      const generation = this.generation;
      if (!this.ticket) {
        const context = this.desiredContext;
        this.nextConfig = now + KEEPALIVE_MS;
        const result = await this.call('config', signal => this.options.api.getTypingTicket!(this.options.ownerId, context, signal));
        if (!this.current(generation)) continue;
        if (!result.ok) {
          this.backoff();
          continue;
        }
        if (result.value === undefined) {
          this.retryAt = this.scheduler.now() + BACKOFF_MS;
          this.report('Weixin typing is unavailable; retrying later.');
          continue;
        }
        if (!boundedString(result.value, 8192) || !result.value.trim()) {
          this.backoff();
          continue;
        }
        this.ticket = { value: result.value, context, expires: this.scheduler.now() + TICKET_MS };
        continue;
      }
      const ticket = this.ticket.value;
      // Even an aborted/rejected start may have reached the server.
      this.activeTicket = ticket;
      this.resetKeepaliveAfterStop = false;
      const result = await this.call('start', signal => this.options.api.sendTyping!(this.options.ownerId, ticket, 1, signal));
      this.nextStart = this.scheduler.now() + KEEPALIVE_MS;
      if (!this.current(generation)) {
        this.cancelNeeded = true;
        continue;
      }
      if (!result.ok) {
        this.cancelNeeded = true;
        this.ticket = undefined;
        this.backoff();
        continue;
      }
      this.failures = 0;
      this.retryAt = 0;
    }
  }

  private current(generation: number): boolean {
    return !this.disposed && !!this.desiredContext && this.generation === generation;
  }

  private async call<T>(kind: Request['kind'], operation: (signal: AbortSignal) => Promise<T>): Promise<Result<T>> {
    const controller = new AbortController();
    const request: Request = {
      kind, controller,
      timer: this.scheduler.setTimeout(() => controller.abort(), kind === 'cancel' ? CANCEL_MS : REQUEST_MS),
    };
    this.request = request;
    try {
      // Do not race the adapter promise: a non-cooperative adapter must not
      // overlap a later start/cancel. dispose has its own bounded wait.
      const value = await operation(controller.signal);
      return controller.signal.aborted ? { ok: false } : { ok: true, value };
    } catch {
      return { ok: false };
    } finally {
      this.scheduler.clearTimeout(request.timer);
      this.request = undefined;
    }
  }

  private backoff(): void {
    this.failures = Math.min(this.failures + 1, 5);
    this.retryAt = this.scheduler.now() + Math.min(BACKOFF_MS, KEEPALIVE_MS * 2 ** (this.failures - 1));
    this.report('Weixin typing request failed; retrying later.');
  }

  private report(message: string): void {
    const now = this.scheduler.now();
    if (now - this.lastDiagnostic < DIAGNOSTIC_MS) return;
    this.lastDiagnostic = now;
    try { this.options.log(message); } catch { /* Optional diagnostics cannot affect the channel. */ }
  }

  private clearWake(): void {
    if (this.wakeTimer !== undefined) this.scheduler.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
  }

  private finishDisposal(): void {
    this.clearWake();
    this.ticket = undefined;
    if (this.disposalTimer !== undefined) this.scheduler.clearTimeout(this.disposalTimer);
    this.disposalTimer = undefined;
    if (this.request) {
      this.request.controller.abort();
      this.scheduler.clearTimeout(this.request.timer);
    }
    this.resolveDisposal?.();
    this.resolveDisposal = undefined;
  }
}
