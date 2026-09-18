import { randomUUID } from 'node:crypto';
import type { SessionState } from '@microsoft/agent-host-protocol';
import { HostConnection } from './ahp.js';
import { Bridge } from './bridge.js';
import { diagnostic, pause, retryDelay, SafeError } from './common.js';
import type { Host } from './endpoints.js';
import { Inbox } from './inbox.js';
import { bindingKey, type Binding, Vault } from './storage.js';
import type { BotApi } from './weixin.js';
import type { RuntimeHealth } from './channelState.js';

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

  constructor(private readonly options: RuntimeOptions) {}

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.abort.signal.aborted) return Promise.reject(new SafeError('This channel instance is stopped. Connect again.'));
    let ready!: () => void;
    let rejected!: (error: unknown) => void;
    this.starting = new Promise((resolve, reject) => { ready = resolve; rejected = reject; });
    let started = false;
    this.running = this.run(() => { started = true; ready(); }).catch(error => {
      rejected(error);
      if (error instanceof SafeError && error.kind === 'auth') this.options.health?.({ account: 'Sign-in required' });
      if (started && !this.abort.signal.aborted) this.options.failed(diagnostic(error));
    }).finally(async () => {
      try { await this.options.vault.invalidateReplies(bindingKey(this.options.binding)); }
      catch (error) { this.options.failed(diagnostic(error)); }
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
      try {
        this.options.assertAllowed();
        this.options.status(attempts ? `Reconnecting (${attempts}/5)` : 'Connecting');
        const host = await this.options.resolveHost();
        signal.throwIfAborted();
        connection = await HostConnection.connect(host, signal, this.clientId, this.options.ackTimeout, () => this.sequence++);
        const inbox = new Inbox(this.options.vault, this.options.binding, this.options.api, this.options.log);
        bridge = await Bridge.open(connection, this.options.binding, inbox, signal, this.options.log, this.options.assertAllowed, this.options.assertScope, this.options.health);
        signal.throwIfAborted();
        this.options.assertAllowed();
        connectedAt = Date.now();
        this.options.status('Connected');
        ready();
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
        this.options.health?.({ receive: 'Stopped', agent: 'Unknown' });
        attempt.abort(new SafeError('Connection attempt ended.'));
        if (polling) await Promise.allSettled([polling]);
        try { if (bridge) await bridge.close(); }
        finally { if (connection) await connection.close(); }
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
