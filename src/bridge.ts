import {
  ActionType, MessageKind, PendingMessageKind, ResponsePartKind, ToolCallStatus, chatReducer,
  type ChatState, type Message, type SessionState,
} from '@microsoft/agent-host-protocol';
import type { Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { HostConnection } from './ahp.js';
import { boundedString, MAX_TEXT_BYTES, SafeError, withAbort } from './common.js';
import { Inbox, REQUEST_META } from './inbox.js';
import type { Binding } from './storage.js';
import { TextSync, visibleText } from './textSync.js';
import { agentStatus, type AgentStatus, type RuntimeHealth } from './channelState.js';

export class Bridge {
  private readonly lifetime = new AbortController();
  private readonly sync: TextSync;
  private state: ChatState;
  private sequence: number;
  private loop?: Promise<void>;
  private work: Promise<void> = Promise.resolve();
  private pendingJobs = 0;
  private flushing?: Promise<void>;
  private flushRequested = false;
  private heartbeat?: NodeJS.Timeout;
  private closing?: Promise<void>;
  private published = false;
  private activityEnabled = false;
  private activityWork: Promise<void> = Promise.resolve();
  private agent: AgentStatus = 'Unknown';
  private readonly waitingInputs = new Set<string>();
  private readonly stopListener: () => void;
  private fail!: (error: Error) => void;
  readonly failure = new Promise<Error>(resolve => { this.fail = resolve; });

  private constructor(
    readonly connection: HostConnection, readonly binding: Binding, readonly inbox: Inbox,
    private readonly subscription: Subscription, snapshot: ChatState, sequence: number,
    private readonly log: (message: string) => void, private readonly assertAllowed: () => void,
    private readonly health: (update: RuntimeHealth) => void,
  ) {
    this.sequence = sequence;
    this.state = {
      ...snapshot, turns: [], draft: undefined,
      activeTurn: snapshot.activeTurn ? {
        ...snapshot.activeTurn,
        responseParts: snapshot.activeTurn.responseParts.filter(part => part.kind === ResponsePartKind.Markdown),
      } : undefined,
    };
    this.sync = new TextSync(inbox, connection.clientId, log, text => connection.containsCredential(text));
    for (const part of snapshot.activeTurn?.responseParts ?? []) {
      if (part.kind === ResponsePartKind.ToolCall && [
        ToolCallStatus.PendingConfirmation, ToolCallStatus.PendingResultConfirmation, ToolCallStatus.AuthRequired,
      ].some(status => status === part.toolCall.status)) this.waitingInputs.add(`tool:${part.toolCall.toolCallId}`);
      if (part.kind === ResponsePartKind.InputRequest && part.response === undefined) this.waitingInputs.add(`input:${part.request.id}`);
    }
    this.reportAgent(snapshot.activeTurn ? this.waitingInputs.size ? 'Awaiting input' : 'Busy' : agentStatus(snapshot.status));
    this.stopListener = connection.onEvent(event => {
      if (event.event.type === 'authRequired') {
        this.stopWith(new SafeError('Agent provider needs authentication. Complete it in VS Code; WeChat cannot approve tools.'));
      }
      if (event.event.type === 'action' && !event.event.params.rejectionReason) {
        const type = event.event.params.action.type;
        if ((event.channel === binding.session && [
          ActionType.SessionWorkingDirectorySet, ActionType.SessionWorkingDirectoryRemoved,
          ActionType.SessionWorkingDirectoryReplaced, ActionType.SessionChatRemoved,
        ].some(action => action === type)) || (event.channel === binding.chat && [
          ActionType.ChatWorkingDirectorySet, ActionType.ChatWorkingDirectoryRemoved,
        ].some(action => action === type))) {
          this.stopWith(new SafeError('Bound session/chat scope changed. Text sync stopped; review the workspace and reconnect.'));
        }
      }
    });
  }

  static async open(
    connection: HostConnection, binding: Binding, inbox: Inbox, signal: AbortSignal, log: (message: string) => void,
    assertAllowed: () => void = () => undefined,
    assertScope: (session: SessionState) => Promise<void> = async () => undefined,
    health: (update: RuntimeHealth) => void = () => undefined,
  ): Promise<Bridge> {
    let changed = false;
    const guard = connection.onEvent(event => {
      if (event.event.type === 'action' && !event.event.params.rejectionReason
        && (event.channel === binding.session || event.channel === binding.chat)
        && /\/workingDirectory(Set|Removed|Replaced)$/.test(event.event.params.action.type)) changed = true;
    });
    let bridge: Bridge | undefined;
    try {
      const session = await connection.session(binding.session, signal);
      const summary = session.chats.find(chat => chat.resource === binding.chat);
      if (!summary || summary.interactivity && summary.interactivity !== 'full') {
        throw new SafeError('Exact selected chat is missing or not interactive.');
      }
      const { result, subscription } = await withAbort(connection.client.subscribe(binding.chat, {
        view: { turns: 64 }, delivery: { maxLatencyMs: 0 },
      }), signal);
      const snapshot = result.snapshot;
      if (!snapshot || snapshot.resource !== binding.chat || !('turns' in snapshot.state)
        || snapshot.state.resource !== binding.chat || !Array.isArray(snapshot.state.turns)) {
        await connection.client.unsubscribe(binding.chat);
        await subscription.close();
        throw new SafeError('Agent Host did not return the exact selected chat state.');
      }
      const allowed = () => {
        assertAllowed();
        if (changed) throw new SafeError('Session workspace changed during connection; reconnect after review.');
      };
      bridge = new Bridge(connection, binding, inbox, subscription, snapshot.state, snapshot.fromSeq, log, allowed, health);
      await assertScope({
        ...session, chats: session.chats.map(chat => chat.resource === binding.chat
          ? { ...chat, workingDirectories: snapshot.state && 'workingDirectories' in snapshot.state ? snapshot.state.workingDirectories : undefined } : chat),
      });
      await inbox.recover(snapshot.state);
      await bridge.sync.open(snapshot.state);
      signal.throwIfAborted();
      bridge.ensureAllowed();
      bridge.loop = bridge.consume();
      bridge.published = true;
      await withAbort(connection.dispatch(binding.session, {
        type: ActionType.SessionActiveClientSet,
        activeClient: { clientId: connection.clientId, displayName: 'WeChat AHP (two-way text sync)', tools: [] },
      }), signal);
      bridge.requestFlush();
      bridge.heartbeat = setInterval(() => {
        void connection.client.ping().catch(() => bridge?.stopWith(new SafeError('Agent Host heartbeat failed.', true, 'transport')));
      }, 15_000);
      bridge.heartbeat.unref();
      return bridge;
    } catch (error) {
      await bridge?.close();
      throw error;
    } finally { guard(); }
  }

  async deliverPending(signal: AbortSignal): Promise<void> {
    for (const event of this.inbox.pending()) {
      let submitted = false;
      let acknowledged = false;
      try {
        this.ensureAllowed();
        signal.throwIfAborted();
        if (this.connection.containsCredential(event.text) || this.inbox.containsCredential(event.text)) {
          throw new SafeError('Incoming text contains a private transport credential; inspect and clear the pending journal.');
        }
        const message: Message = {
          origin: { kind: MessageKind.User }, text: event.text, _meta: { [REQUEST_META]: event.id },
        };
        const busy = this.state.activeTurn !== undefined || (this.state.queuedMessages?.length ?? 0) > 0;
        const id = randomUUID();
        await this.inbox.markDispatching(event.id, busy ? undefined : id, busy ? id : undefined);
        if (busy) await this.sync.queued(id, message);
        else await this.sync.started(id, message);
        this.ensureAllowed();
        signal.throwIfAborted();
        const action = busy ? {
          type: ActionType.ChatPendingMessageSet, kind: PendingMessageKind.Queued, id, message,
        } as const : {
          type: ActionType.ChatTurnStarted, turnId: id, startedAt: new Date().toISOString(), message,
        } as const;
        this.state = chatReducer(this.state, action);
        submitted = true;
        await withAbort(this.connection.dispatch(this.binding.chat, action), AbortSignal.any([signal, this.lifetime.signal]));
        acknowledged = true;
        await this.inbox.accepted(event.id, busy ? undefined : id);
        this.log(busy ? 'WeChat original text queued in the existing chat.' : 'WeChat original text accepted into the existing chat.');
      } catch (error) {
        if (acknowledged) await this.inbox.result(event.id, 'uncertain', error);
        else if (!submitted && !signal.aborted || error instanceof SafeError && error.kind === 'ahp-rejected') {
          await this.inbox.result(event.id, 'failed', error);
        }
        throw error;
      }
    }
    this.requestFlush();
  }

  private async consume(): Promise<void> {
    try {
      for await (const event of this.subscription) {
        if (this.lifetime.signal.aborted) break;
        this.observe(event);
      }
      if (!this.lifetime.signal.aborted) this.stopWith(new SafeError('Chat subscription ended; reconnecting.', true, 'transport'));
    } catch (error) {
      this.stopWith(error instanceof SafeError ? error : new SafeError('Invalid Agent Host text event; sync stopped.', false, 'protocol'));
    }
  }

  private observe(event: SubscriptionEvent): void {
    if (event.type !== 'action' || event.params.channel !== this.binding.chat || event.params.rejectionReason) return;
    const { action, serverSeq } = event.params;
    if (serverSeq <= this.sequence) return;
    this.sequence = serverSeq;
    switch (action.type) {
      case ActionType.ChatTurnStarted:
        if (this.state.activeTurn?.id !== action.turnId) {
          this.waitingInputs.clear();
          this.state = chatReducer(this.state, action);
        }
        this.reportAgent();
        this.enqueue(() => this.sync.started(action.turnId, action.message, action.queuedMessageId));
        break;
      case ActionType.ChatPendingMessageSet:
        this.state = chatReducer(this.state, action);
        if (action.kind === PendingMessageKind.Queued) this.enqueue(() => this.sync.queued(action.id, action.message));
        else if (action.kind === PendingMessageKind.Steering) this.enqueue(() => this.sync.steering(action.id, action.message));
        break;
      case ActionType.ChatPendingMessageRemoved:
        this.state = chatReducer(this.state, action);
        if (action.kind === PendingMessageKind.Queued) this.enqueue(() => this.sync.cancel('', action.id));
        break;
      case ActionType.ChatResponsePart: {
        if (action.part.kind !== ResponsePartKind.Markdown || this.state.activeTurn?.id !== action.turnId) return;
        const partId = action.part.id;
        if (this.state.activeTurn.responseParts.some(part => part.kind === ResponsePartKind.Markdown && part.id === partId)) return;
        if (this.state.activeTurn.responseParts.length >= 128) throw new SafeError('Too many assistant text parts; sync stopped.');
        this.state = chatReducer(this.state, action);
        visibleText(this.state.activeTurn!);
        break;
      }
      case ActionType.ChatDelta:
        if (!boundedString(action.content, MAX_TEXT_BYTES, true)) throw new SafeError('Assistant text delta is oversized; sync stopped.');
        this.state = chatReducer(this.state, action);
        if (this.state.activeTurn) visibleText(this.state.activeTurn);
        break;
      case ActionType.ChatTurnComplete: {
        const turn = this.state.activeTurn;
        if (!turn || turn.id !== action.turnId) return;
        this.state = { ...this.state, activeTurn: undefined };
        this.waitingInputs.clear();
        this.reportAgent('Idle');
        this.enqueue(() => this.sync.complete(turn));
        break;
      }
      case ActionType.ChatTurnCancelled:
      case ActionType.ChatError:
        if (this.state.activeTurn?.id === action.turnId) {
          this.state = { ...this.state, activeTurn: undefined };
          this.waitingInputs.clear();
          this.reportAgent(action.type === ActionType.ChatError ? 'Error' : 'Idle');
        }
        this.enqueue(() => this.sync.cancel(action.turnId));
        break;
      case ActionType.ChatToolCallReady:
        if (this.state.activeTurn?.id === action.turnId) this.setWaiting(`tool:${action.toolCallId}`, action.confirmed === undefined);
        break;
      case ActionType.ChatInputRequested:
        if (this.state.activeTurn) this.setWaiting(`input:${action.request.id}`, true);
        break;
      case ActionType.ChatToolCallConfirmed:
      case ActionType.ChatToolCallResultConfirmed:
        if (this.state.activeTurn?.id === action.turnId) this.setWaiting(`tool:${action.toolCallId}`, false);
        break;
      case ActionType.ChatToolCallComplete:
        if (this.state.activeTurn?.id === action.turnId) this.setWaiting(`tool:${action.toolCallId}`, action.requiresResultConfirmation === true);
        break;
      case ActionType.ChatToolCallAuthRequired:
        if (this.state.activeTurn?.id === action.turnId) this.setWaiting(`tool:${action.toolCallId}`, true);
        break;
      case ActionType.ChatToolCallAuthResolved:
        if (this.state.activeTurn?.id === action.turnId) this.setWaiting(`tool:${action.toolCallId}`, false);
        break;
      case ActionType.ChatInputCompleted:
        if (this.waitingInputs.has(`input:${action.requestId}`)) this.setWaiting(`input:${action.requestId}`, false);
        break;
      // Reasoning, tool calls/results, resource references, drafts and history are never mirrored.
    }
  }

  private enqueue(work: () => Promise<void>): void {
    if (++this.pendingJobs > 128) { this.stopWith(new SafeError('Text sync event backlog exceeded 128; no silent event dropping.')); return; }
    const next = this.work.then(async () => { this.ensureAllowed(); await work(); this.requestFlush(); });
    this.work = next.then(() => { this.pendingJobs--; }, error => { this.pendingJobs--; this.stopWith(error); });
  }

  private requestFlush(): void {
    if (this.lifetime.signal.aborted) return;
    this.flushRequested = true;
    if (this.flushing) return;
    this.flushing = (async () => {
      while (this.flushRequested && !this.lifetime.signal.aborted) {
        this.flushRequested = false;
        this.ensureAllowed();
        await this.sync.flush(this.lifetime.signal);
      }
    })().catch(error => this.stopWith(error)).finally(() => { this.flushing = undefined; });
  }

  private ensureAllowed(): void {
    this.assertAllowed();
    this.lifetime.signal.throwIfAborted();
  }

  enableActivity(): void {
    this.activityEnabled = true;
    this.reportAgent(this.agent);
  }

  private reportAgent(agent: AgentStatus = this.state.activeTurn ? this.waitingInputs.size ? 'Awaiting input' : 'Busy' : 'Idle'): void {
    this.agent = agent;
    this.health({ agent });
    if (this.activityEnabled && !this.lifetime.signal.aborted) {
      const work = this.sync.setActivity(agent === 'Awaiting input', this.state.activeTurn?.id)
        .then(() => this.requestFlush());
      this.activityWork = Promise.all([this.activityWork, work]).then(() => undefined);
    }
  }

  private setWaiting(key: string, waiting: boolean): void {
    if (waiting) this.waitingInputs.add(key);
    else this.waitingInputs.delete(key);
    if (this.waitingInputs.size > 128) throw new SafeError('Too many pending Agent input requests; channel stopped.');
    this.reportAgent();
  }

  private stopWith(error: unknown): void {
    if (this.lifetime.signal.aborted) return;
    const failure = error instanceof Error ? error : new SafeError('Text sync failed.');
    this.lifetime.abort(failure);
    this.fail(failure);
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.activityEnabled = false;
    this.sync.pauseActivity();
    this.lifetime.abort();
    clearInterval(this.heartbeat);
    this.stopListener();
    await this.connection.client.unsubscribe(this.binding.chat);
    await this.subscription.close();
    await this.loop;
    await this.activityWork;
    await this.work;
    await this.flushing;
    if (this.published && this.connection.client.connectionState.status === 'connected') {
      try {
        await this.connection.dispatch(this.binding.session, { type: ActionType.SessionActiveClientRemoved, clientId: this.connection.clientId });
      } catch { this.log('Could not confirm removal of this client; Host will remove it on disconnect.'); }
    }
    await this.connection.client.unsubscribe(this.binding.session);
  }
}
