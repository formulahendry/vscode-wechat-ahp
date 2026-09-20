import { randomUUID } from 'node:crypto';
import type { SessionState } from '@microsoft/agent-host-protocol';
import { HostConnection } from './ahp.js';
import { Bridge } from './bridge.js';
import { diagnostic, pause, retryDelay, SafeError } from './common.js';
import type { Host } from './endpoints.js';
import { Inbox } from './inbox.js';
import { bindingKey, type Binding, Vault } from './storage.js';
import type { BotApi } from './weixin.js';
import type { AgentStatus, RuntimeHealth } from './channelState.js';
import { TypingController } from './typing.js';
import { closingResults, MessageEvents, STORAGE_RESULT_ERROR, type MessageObserver } from './messageEvents.js';

export interface RuntimeOptions {
  binding: Binding;
  vault: Vault;
  api: BotApi;
  resolveHost(): Promise<Host>;
  assertAllowed(): void;
  assertScope(session: SessionState): Promise<void>;
  log(message: string): void;
  status(status: string): void;
  failed(message: string): void;
  terminalError?(error: unknown): void;
  messages?: MessageObserver;
  health?(update: RuntimeHealth): void;
  wait?: typeof pause;
  ackTimeout?: number;
}

export class ChannelRuntime {
  private readonly abort = new AbortController();
  private running?: Promise<void>;
  private starting?: Promise<void>;
  private stopWork?: Promise<void>;
  private readonly clientId = randomUUID();
  private sequence = 1;
  private readonly messages: MessageEvents;

  constructor(private readonly options: RuntimeOptions) {
    this.messages = new MessageEvents(options.messages, options.log);
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.abort.signal.aborted) return Promise.reject(new SafeError('This channel instance is stopped. Connect again.'));
    let ready!: () => void;
    let rejected!: (error: unknown) => void;
    this.starting = new Promise((resolve, reject) => { ready = resolve; rejected = reject; });
    let started = false;
    let terminalReported = false;
    const reportTerminal = (error: unknown) => {
      if (started && !terminalReported) {
        terminalReported = true;
        this.options.terminalError?.(error);
      }
    };
    this.running = this.run(() => { started = true; ready(); }).catch(error => {
      rejected(error);
      if (error instanceof SafeError && error.kind === 'auth') this.options.health?.({ account: 'Sign-in required' });
      if (started && !this.abort.signal.aborted) {
        reportTerminal(error);
        this.options.failed(diagnostic(error));
      }
    }).finally(async () => {
      const key = bindingKey(this.options.binding);
      try { this.messages.results(await this.options.vault.invalidateReplies(key)); }
      catch (error) {
        this.messages.results(closingResults(this.options.vault.snapshot(), key), STORAGE_RESULT_ERROR());
        reportTerminal(error); this.options.failed(diagnostic(error));
      }
      this.options.status('Disconnected');
      this.options.health?.({ receive: 'Stopped', agent: 'Unknown' });
      rejected(new SafeError('Connection cancelled.'));
    });
    return this.starting;
  }

  get finished(): Promise<void> { return this.running ?? Promise.resolve(); }

  async stop(): Promise<void> {
    if (!this.stopWork) {
      this.abort.abort(new SafeError('Channel disconnected.'));
      this.options.status('Disconnecting');
      this.stopWork = this.running ?? Promise.resolve();
    }
    await this.stopWork;
  }

  private async run(ready: () => void): Promise<void> {
    const outer = this.abort.signal;
    let attempts = 0;
    while (!outer.aborted) {
      const attempt = new AbortController();
      const signal = AbortSignal.any([outer, attempt.signal]);
      let connection: HostConnection | undefined;
      let bridge: Bridge | undefined;
      let polling: Promise<void> | undefined;
      let retry: Error | undefined;
      let connectedAt = 0;
      let typing: TypingController | undefined;
      let unwatch: (() => void) | undefined;
      let agent: AgentStatus = 'Unknown';
      let activityAllowed = false;
      const updateTyping = () => {
        if (!typing) return;
        if (!activityAllowed || signal.aborted) { typing.update('Unknown'); return; }
        try { this.options.assertAllowed(); }
        catch { typing.update('Unknown'); return; }
        const state = this.options.vault.snapshot();
        typing.update(agent, state.peer?.binding === bindingKey(this.options.binding) ? state.peer.contextToken : undefined);
      };
      try {
        this.options.assertAllowed();
        this.options.status(attempts ? `Reconnecting (${attempts}/5)` : 'Connecting');
        const host = await this.options.resolveHost();
        signal.throwIfAborted();
        connection = await HostConnection.connect(host, signal, this.clientId, this.options.ackTimeout, () => this.sequence++);
        const inbox = new Inbox(this.options.vault, this.options.binding, this.options.api, this.options.log, this.messages);
        bridge = await Bridge.open(connection, this.options.binding, inbox, signal, this.options.log,
          this.options.assertAllowed, this.options.assertScope, update => {
            if (update.agent) agent = update.agent;
            this.options.health?.(update);
            updateTyping();
          });
        signal.throwIfAborted();
        this.options.assertAllowed();
        connectedAt = Date.now();
        this.options.status('Connected');
        ready();
        typing = new TypingController({
          api: this.options.api, ownerId: this.options.vault.snapshot().credentials.ownerId, log: this.options.log,
        });
        activityAllowed = true;
        unwatch = this.options.vault.onDidChange(updateTyping);
        updateTyping();
        bridge.enableActivity();
        polling = this.poll(inbox, bridge, signal);
        await Promise.race([
          polling,
          bridge.failure.then(error => { throw error; }),
          connection.closed.then(() => { throw new SafeError('Agent Host disconnected.', true, 'transport'); }),
        ]);
        if (!signal.aborted) throw new SafeError('Channel poller ended unexpectedly.');
      } catch (error) {
        if (!outer.aborted) {
          if (connectedAt && Date.now() - connectedAt > 60_000) attempts = 0;
          if (!(error instanceof SafeError) || !error.retryable || ++attempts > 5) throw error;
          retry = error;
        }
      } finally {
        activityAllowed = false;
        unwatch?.();
        typing?.update('Unknown');
        this.options.health?.({ receive: 'Stopped', agent: 'Unknown' });
        attempt.abort(new SafeError('Connection attempt ended.'));
        try {
          await Promise.all([bridge?.close(), typing?.dispose(), Promise.allSettled(polling ? [polling] : [])]);
        } finally { if (connection) await connection.close(); }
      }
      if (retry && !outer.aborted) {
        this.options.status(`Reconnecting (${attempts}/5)`);
        this.options.log(`${diagnostic(retry)} Retrying local connection (${attempts}/5); exact binding retained.`);
        await (this.options.wait ?? pause)(retryDelay(attempts), outer);
      }
    }
  }

  private async poll(inbox: Inbox, bridge: Bridge, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.options.assertAllowed();
      await bridge.deliverPending(signal);
      let batch;
      try {
        this.options.health?.({ receive: 'Polling' });
        batch = await this.options.api.updates(inbox.vault.snapshot().cursor, signal);
        failures = 0;
        this.options.health?.({ receive: 'Polling', lastPollAt: new Date().toISOString() });
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof SafeError) || !error.retryable) {
          this.options.health?.({ receive: 'Failed' });
          throw error;
        }
        if (++failures > 6) throw new SafeError('Weixin polling failed after six retries. Reconnect manually after checking network/sign-in.');
        this.options.health?.({ receive: `Retrying (${failures}/6)` });
        this.options.log(`${diagnostic(error)} Retrying Weixin long poll (${failures}/6).`);
        await (this.options.wait ?? pause)(retryDelay(failures), signal);
        continue;
      }
      this.options.assertAllowed();
      await inbox.accept(batch, signal);
      await bridge.deliverPending(signal);
      await (this.options.wait ?? pause)(250, signal);
    }
  }
}
