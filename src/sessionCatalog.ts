import type { SessionState, SessionSummary } from '@microsoft/agent-host-protocol';
import { HostConnection } from './ahp.js';
import { diagnostic, hash, SafeError, withAbort } from './common.js';
import { selectionFailure } from './diagnostics.js';
import { discoverHosts, resolveHost, type Host } from './endpoints.js';
import { label } from './ui.js';

export interface CatalogHost {
  kind: 'host'; id: string; hostId: string; title: string;
  product: string; pid: number; protocolVersion: string; endpointType: string;
  health: 'Discovered' | 'Reachable' | 'Unavailable';
}
export interface CatalogSession {
  kind: 'session'; id: string; parentId: string; hostId: string;
  resource: string; title: string; provider: string; status: number;
}
export interface CatalogChat {
  kind: 'chat'; id: string; parentId: string; hostId: string; session: string;
  resource: string; title: string; status: number; eligible: boolean; unavailableReason?: string;
  workingDirectories: string[];
}
export interface CatalogNotice {
  kind: 'notice'; id: string; parentId?: string; title: string;
}
export type CatalogNode = CatalogHost | CatalogSession | CatalogChat | CatalogNotice;
interface Page { items: CatalogSession[]; cursor?: string; cursors: Set<string>; }
export interface CatalogOptions {
  assertAllowed(): void;
  log(message: string): void;
  discover?: () => Promise<Host[]>;
  resolve?: (id: string) => Promise<Host>;
  connect?: typeof HostConnection.connect;
}

export class SessionCatalog {
  private hosts?: CatalogHost[];
  private readonly nodes = new Map<string, CatalogNode>();
  private readonly pages = new Map<string, Page>();
  private readonly chats = new Map<string, CatalogChat[]>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, Promise<CatalogNode[]>>();
  private readonly errors = new Map<string, CatalogNotice[]>();
  private abort = new AbortController();
  private generation = 0;
  private requests = 0;
  private disposed = false;

  constructor(private readonly options: CatalogOptions) {}

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  node(id: string): CatalogNode | undefined { return this.nodes.get(id); }
  hasMore(hostId: string): boolean { return !!this.pages.get(hostId)?.cursor; }

  refresh(node?: CatalogNode): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.generation++;
    this.pending.clear();
    if (!node) {
      this.hosts = undefined; this.pages.clear(); this.chats.clear(); this.nodes.clear(); this.errors.clear();
    } else if (node.kind === 'host') {
      this.pages.delete(node.hostId);
      this.errors.delete(node.id);
      for (const [id, candidate] of this.nodes) {
        if ('hostId' in candidate && candidate.hostId === node.hostId && candidate.kind !== 'host') {
          this.chats.delete(id); this.nodes.delete(id); this.errors.delete(id);
        }
      }
    } else if (node.kind === 'session') {
      this.chats.delete(node.id);
      this.errors.delete(node.id);
      for (const [id, candidate] of this.nodes) if ('parentId' in candidate && candidate.parentId === node.id) this.nodes.delete(id);
    }
    this.changed();
  }

  async children(node?: CatalogNode): Promise<CatalogNode[]> {
    if (this.disposed) return [];
    const key = node?.id ?? 'root';
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const signal = this.abort.signal;
    const work = (async () => {
      try {
        this.options.assertAllowed();
        const failure = this.errors.get(key);
        if (failure) return failure;
        let result: CatalogNode[];
        if (!node) result = await this.loadHosts(generation, signal);
        else if (node.kind === 'host') result = await this.loadSessions(node, false, generation, signal);
        else if (node.kind === 'session') result = await this.loadChats(node, generation, signal);
        else result = [];
        if (generation !== this.generation || signal.aborted) return [];
        return result;
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return [];
        const text = diagnostic(selectionFailure('catalog', error));
        this.options.log(text);
        const items: CatalogNotice[] = [{ kind: 'notice', id: `error-${key}`, parentId: node?.id, title: text }];
        this.errors.set(key, items);
        this.changed();
        return items;
      }
    })();
    this.pending.set(key, work);
    try { return await work; }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  private current(generation: number, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (generation !== this.generation || this.disposed) throw new SafeError('Catalog request was superseded.');
    this.options.assertAllowed();
  }

  private async loadHosts(generation: number, signal: AbortSignal): Promise<CatalogHost[]> {
    if (this.hosts) return this.hosts;
    const discovered = await (this.options.discover?.() ?? discoverHosts(undefined, this.options.log));
    this.current(generation, signal);
    this.hosts = discovered.map(host => ({
      kind: 'host', id: `host-${hash(host.id)}`, hostId: host.id, title: `${host.product} / PID ${host.pid}`,
      product: host.product, pid: host.pid, protocolVersion: host.protocolVersion, endpointType: host.endpoint.type,
      health: 'Discovered',
    }));
    for (const host of this.hosts) this.nodes.set(host.id, host);
    return this.hosts;
  }

  private async withHost<T>(hostId: string, signal: AbortSignal, work: (connection: HostConnection) => Promise<T>): Promise<T> {
    this.options.assertAllowed();
    if (this.requests >= 4) throw new SafeError('Four catalog requests are already running. Refresh this item after they finish.');
    this.requests++;
    let connection: HostConnection | undefined;
    try {
      const host = await (this.options.resolve?.(hostId) ?? resolveHost(hostId, this.options.log));
      signal.throwIfAborted();
      connection = await (this.options.connect ?? HostConnection.connect)(host, signal);
      const result = await withAbort(work(connection), signal);
      signal.throwIfAborted();
      const entry = this.hosts?.find(item => item.hostId === hostId);
      if (entry) entry.health = 'Reachable';
      return result;
    } catch (error) {
      if (!signal.aborted) {
        const entry = this.hosts?.find(item => item.hostId === hostId);
        if (entry) entry.health = 'Unavailable';
      }
      throw error;
    } finally {
      try { await connection?.close(); }
      finally { this.requests--; }
    }
  }

  private async loadSessions(host: CatalogHost, more: boolean, generation: number, signal: AbortSignal): Promise<CatalogSession[]> {
    const previous = this.pages.get(host.hostId);
    if (previous && !more) return previous.items;
    if (more && !previous?.cursor) return previous?.items ?? [];
    const result = await this.withHost(host.hostId, signal, connection => connection.listSessionsPage(signal, previous?.cursor));
    this.current(generation, signal);
    const cursors = new Set(previous?.cursors);
    if (result.nextCursor) {
      if (cursors.has(result.nextCursor)) throw new SafeError('Host repeated a session catalog cursor.');
      cursors.add(result.nextCursor);
    }
    const items = [...(previous?.items ?? [])];
    for (const session of result.items) {
      const node = this.sessionNode(host, session);
      const index = items.findIndex(item => item.id === node.id);
      if (index >= 0) items[index] = node;
      else items.push(node);
    }
    if (items.length > 2000) throw new SafeError('Session catalog reached its 2000-entry limit.');
    this.pages.set(host.hostId, { items, cursor: result.nextCursor, cursors });
    for (const item of items) this.nodes.set(item.id, item);
    this.changed();
    return items;
  }

  private sessionNode(host: CatalogHost, summary: SessionSummary): CatalogSession {
    return {
      kind: 'session', id: `session-${hash(JSON.stringify([host.hostId, summary.resource]))}`,
      parentId: host.id, hostId: host.hostId, resource: summary.resource,
      title: label(summary.title) || '(Untitled session)', provider: label(summary.provider), status: summary.status,
    };
  }

  private async loadChats(session: CatalogSession, generation: number, signal: AbortSignal): Promise<CatalogChat[]> {
    const cached = this.chats.get(session.id);
    if (cached) return cached;
    const state = await this.withHost(session.hostId, signal, connection => connection.session(session.resource, signal));
    this.current(generation, signal);
    if (state.chats.length > 500) throw new SafeError('Session has more than 500 chats; use Select Existing Host / Session / Chat instead.');
    const items: CatalogChat[] = [];
    for (const chat of state.chats) {
      let unavailableReason: string | undefined;
      if (chat.interactivity && chat.interactivity !== 'full') unavailableReason = 'This chat is not interactive.';
      this.current(generation, signal);
      items.push({
        kind: 'chat', id: `chat-${hash(JSON.stringify([session.hostId, session.resource, chat.resource]))}`,
        parentId: session.id, hostId: session.hostId, session: session.resource, resource: chat.resource,
        title: label(chat.title) || '(Untitled chat)', status: chat.status, eligible: !unavailableReason, unavailableReason,
        workingDirectories: this.safeDirectories(state, chat.workingDirectories),
      });
    }
    this.chats.set(session.id, items);
    for (const item of items) this.nodes.set(item.id, item);
    this.changed();
    return items;
  }

  private safeDirectories(session: SessionState, chat: string[] | undefined): string[] {
    return [...new Set([...(session.workingDirectories ?? []), ...(chat ?? [])])].filter(value => {
      try { const uri = new URL(value); return uri.protocol === 'file:' && !uri.username && !uri.password && !uri.search && !uri.hash; }
      catch { return false; }
    });
  }

  async loadMore(host: CatalogHost): Promise<void> {
    const key = host.id;
    if (this.pending.has(key)) throw new SafeError('This Host is already loading.');
    const work = this.loadSessions(host, true, this.generation, this.abort.signal);
    this.pending.set(key, work);
    try { await work; this.changed(); }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  async ping(host: CatalogHost): Promise<void> {
    await this.withHost(host.hostId, this.abort.signal, connection => connection.client.ping());
    this.changed();
  }

  async findBinding(binding: { hostId: string; session: string; chat: string }): Promise<CatalogChat> {
    const hosts = await this.children();
    const host = hosts.find((node): node is CatalogHost => node.kind === 'host' && node.hostId === binding.hostId);
    if (!host) throw new SafeError('The exact bound Host is not available. Refresh and select it again.');
    let session: CatalogSession | undefined;
    for (let page = 0; page < 40; page++) {
      session = (await this.children(host)).find((node): node is CatalogSession => node.kind === 'session' && node.resource === binding.session);
      if (session || !this.hasMore(host.hostId)) break;
      await this.loadMore(host);
    }
    if (!session) throw new SafeError('The exact bound session is not in this Host catalog.');
    const chat = (await this.children(session)).find((node): node is CatalogChat => node.kind === 'chat' && node.resource === binding.chat);
    if (!chat) throw new SafeError('The exact bound chat is unavailable.');
    return chat;
  }

  dispose(): void {
    this.disposed = true; this.abort.abort(); this.listeners.clear(); this.nodes.clear();
    this.pages.clear(); this.chats.clear(); this.errors.clear(); this.hosts = undefined;
  }
}
