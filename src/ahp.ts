import {
  SUPPORTED_PROTOCOL_VERSIONS,
  type ActionEnvelope, type ListSessionsResult, type SessionState, type SessionSummary, type StateAction,
} from '@microsoft/agent-host-protocol';
import { AhpClient, type ClientEvent } from '@microsoft/agent-host-protocol/client';
import { randomUUID } from 'node:crypto';
import { boundedString, record, SafeError, withAbort } from './common.js';
import type { Host } from './endpoints.js';
import { isChannelResourceUri } from './resourceUri.js';
import { LocalTransport } from './transport.js';

interface PendingAck {
  channel: string;
  resolve(envelope: ActionEnvelope): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class HostConnection {
  readonly client: AhpClient;
  readonly closed: Promise<void>;
  private readonly pending = new Map<number, PendingAck>();
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private stopping = false;
  private constructor(
    transport: LocalTransport, readonly clientId: string, private readonly ackTimeout: number,
    private readonly credential: string, private readonly nextSequence?: () => number,
  ) {
    this.client = new AhpClient(transport, { requestTimeoutMs: ackTimeout, subscriptionBuffer: 4096 });
    const events = this.client.events();
    this.closed = this.consume(events);
    this.client.connect();
  }

  static async connect(host: Host, signal: AbortSignal, clientId = randomUUID(), timeout = 10_000, nextSequence?: () => number): Promise<HostConnection> {
    const connection = new HostConnection(await LocalTransport.connect(host, signal), clientId, timeout, host.connectionToken, nextSequence);
    try {
      const result = await withAbort(connection.client.initialize({
        clientId, protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS], initialSubscriptions: ['ahp-root://'],
      }), signal);
      if (!SUPPORTED_PROTOCOL_VERSIONS.some(version => version === result.protocolVersion)) {
        throw new SafeError('Agent Host selected an unsupported AHP version. Update VS Code or this extension.');
      }
      return connection;
    } catch (error) {
      await connection.close();
      signal.throwIfAborted();
      if (error instanceof SafeError) throw error;
      throw new SafeError('Agent Host initialize failed. The endpoint must support the bundled AHP SDK 0.9.0.', true, 'transport');
    }
  }

  onEvent(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  containsCredential(text: string): boolean { return text.includes(this.credential); }

  private async consume(events: AsyncIterable<ClientEvent>): Promise<void> {
    try {
      for await (const event of events) {
        if (event.event.type === 'action') {
          const envelope = event.event.params;
          if (envelope.origin?.clientId === this.clientId) {
            const pending = this.pending.get(envelope.origin.clientSeq);
            if (pending && pending.channel === envelope.channel) {
              clearTimeout(pending.timer);
              this.pending.delete(envelope.origin.clientSeq);
              if (envelope.rejectionReason) pending.reject(new SafeError('Agent Host rejected the action. Inspect the bound chat in VS Code; no automatic resend.', false, 'ahp-rejected'));
              else pending.resolve(envelope);
            }
          }
        }
        for (const listener of this.listeners) listener(event);
      }
    } finally {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new SafeError('Agent Host disconnected before acknowledging the action.', true, 'transport'));
      }
      this.pending.clear();
    }
  }

  dispatch(channel: string, action: StateAction): Promise<ActionEnvelope> {
    if (this.stopping || this.client.connectionState.status !== 'connected') {
      return Promise.reject(new SafeError('Agent Host is not connected.', true, 'transport'));
    }
    const { clientSeq } = this.client.dispatch(channel, action, this.nextSequence?.());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientSeq);
        reject(new SafeError('Agent Host acknowledgement timed out. Delivery may be ambiguous; the journal was preserved.', true, 'transport'));
      }, this.ackTimeout);
      this.pending.set(clientSeq, { channel, resolve, reject, timer });
    });
  }

  async listSessions(signal: AbortSignal): Promise<SessionSummary[]> {
    const items: SessionSummary[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 40; page++) {
      const result = await this.listSessionsPage(signal, cursor);
      items.push(...result.items);
      if (!result.nextCursor) return items;
      if (seen.has(result.nextCursor)) throw new SafeError('Agent Host returned a repeated catalog cursor.');
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new SafeError('Agent Host session catalog exceeded 2000 entries.');
  }

  async listSessionsPage(signal: AbortSignal, cursor?: string): Promise<ListSessionsResult> {
    const result = await withAbort(this.client.request('listSessions', { channel: 'ahp-root://', cursor, limit: 50 }), signal);
    if (!record(result) || !Array.isArray(result.items) || result.items.length > 2000 || result.items.some(item =>
      !record(item) || !isChannelResourceUri(item.resource) || typeof item.title !== 'string' || typeof item.provider !== 'string')
      || (result.nextCursor !== undefined && !boundedString(result.nextCursor, 8192))) {
      throw new SafeError('Host returned an invalid AHP session catalog. Update VS Code/provider or select a compatible Host.', false, 'protocol');
    }
    return result;
  }

  async session(uri: string, signal: AbortSignal): Promise<SessionState> {
    if (!isChannelResourceUri(uri)) throw new SafeError('Invalid session resource URI. Select an existing Host-provided session.');
    const { result, subscription } = await withAbort(this.client.subscribe(uri), signal);
    await subscription.close();
    const snapshot = result.snapshot;
    if (!snapshot || snapshot.resource !== uri || !snapshot.state || !('chats' in snapshot.state)
      || !Array.isArray(snapshot.state.chats) || snapshot.state.chats.some(chat =>
        !record(chat) || !isChannelResourceUri(chat.resource) || typeof chat.title !== 'string')) {
      throw new SafeError('Host did not return the selected session snapshot.');
    }
    if (snapshot.state.lifecycle !== 'ready') throw new SafeError('Selected session is not ready. Open it in VS Code first.');
    return snapshot.state;
  }

  async close(): Promise<void> {
    if (this.stopping) return this.closed;
    this.stopping = true;
    await this.client.shutdown();
    await this.closed;
  }
}
