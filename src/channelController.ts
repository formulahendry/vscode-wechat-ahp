import * as vscode from 'vscode';
import QRCode from 'qrcode';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol';
import { HostConnection } from './ahp.js';
import { diagnostic, hash, SafeError } from './common.js';
import { selectionFailure } from './diagnostics.js';
import { discoverHosts, resolveHost } from './endpoints.js';
import { login } from './login.js';
import { OwnerLock } from './lock.js';
import { ChannelRuntime } from './runtime.js';
import { assertSessionScope } from './scope.js';
import { bindingKey, parseBinding, SECRET_KEY, type Binding, Vault } from './storage.js';
import { label, qrHtml } from './ui.js';
import { WeixinApi } from './weixin.js';
import { initialChannelState, privateSummary, sendStatus, type ChannelState } from './channelState.js';
import { SessionCatalog, type CatalogChat } from './sessionCatalog.js';
import { assertLocalDesktop, isLocalDesktop } from './platform.js';

const BINDING_KEY = 'wechat-ahp.binding.v1';
export class ChannelController {
  private readonly output = vscode.window.createOutputChannel('WeChat AHP');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private runtime?: ChannelRuntime;
  private lock?: OwnerLock;
  private releasing?: Promise<void>;
  private operation?: AbortController;
  private operationDone?: Promise<void>;
  private state = initialChannelState();
  private readonly changed = new vscode.EventEmitter<ChannelState>();
  readonly onDidChange = this.changed.event;
  readonly catalog: SessionCatalog;
  private vault?: Vault;
  private unwatchVault?: () => void;
  private refreshGeneration = 0;
  private disposed = false;
  private readonly contextValues = new Map<string, boolean>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.catalog = new SessionCatalog({
      assertAllowed: () => { this.trusted(); },
      roots: () => this.roots(), log: message => this.log(message),
    });
    this.status.command = 'wechatAHP.focus';
    this.setStatus('Disconnected');
    this.status.show();
    context.subscriptions.push(this.output, this.status, this.changed);
    const commands: Record<string, () => Promise<unknown>> = {
      login: () => this.exclusive(signal => this.signIn(signal)),
      selectChat: () => this.exclusive(signal => this.selectChat(signal)),
      connect: () => this.exclusive(signal => this.connect(signal)),
      disconnect: () => this.stop(),
      status: () => this.showStatus(),
      logout: () => this.exclusive(signal => this.logout(signal)),
      clearPending: () => this.exclusive(signal => this.clearPending(signal)),
    };
    for (const [name, action] of Object.entries(commands)) {
      this.registerCommand(name, action);
    }
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.catalog.refresh();
      if (this.runtime || this.operation) {
        void this.stop().catch(error => this.log(diagnostic(error)));
        this.log('Workspace changed; channel stopped. Select and confirm a binding again.');
      }
      void this.refreshState().catch(error => this.reportError(error));
    }));
  }

  registerCommand(name: string, action: (argument?: unknown) => Promise<unknown>): void {
    this.context.subscriptions.push(vscode.commands.registerCommand(`wechatAHP.${name}`, async (argument?: unknown) => {
      try { await action(argument); }
      catch (error) { this.reportError(error); }
      finally {
        try { await this.refreshState(); }
        catch (error) { this.reportError(error); }
      }
    }));
  }

  reportError(error: unknown): void {
    if (this.disposed) return;
    const message = diagnostic(error);
    this.publish({ lastError: message });
    this.log(message);
    void vscode.window.showErrorMessage(`WeChat AHP: ${message}`);
  }

  snapshot(): ChannelState { return structuredClone(this.state); }

  private publish(update: Partial<ChannelState> = {}): void {
    if (this.disposed) return;
    this.state = {
      ...this.state, ...update, active: this.runtime !== undefined, busy: this.operation !== undefined,
      trusted: vscode.workspace.isTrusted && isLocalDesktop({ remoteName: vscode.env.remoteName }),
    };
    for (const [key, value] of Object.entries({
      active: this.state.active, busy: this.state.busy, signedIn: this.state.account === 'Signed in',
      bound: !!this.state.binding, trusted: this.state.trusted,
    })) {
      if (this.contextValues.get(key) === value) continue;
      this.contextValues.set(key, value);
      void vscode.commands.executeCommand('setContext', `wechatAHP.${key}`, value).then(undefined, () => {
        this.contextValues.delete(key);
        this.log('Could not update a view context key.');
      });
    }
    this.status.tooltip = [
      `AHP: ${this.state.phase}`, `WeChat receive: ${this.state.receive}`, `WeChat send: ${sendStatus(this.state)}`,
      `Agent: ${this.state.agent}`, `Chat: ${this.state.binding?.chat ?? 'Not bound'}`,
    ].join('\n');
    this.changed.fire(this.snapshot());
  }

  private observeVault(vault: Vault): void {
    this.unwatchVault?.();
    this.vault = vault;
    const update = () => {
      const summary = privateSummary(vault.snapshot(), this.state.binding);
      if (this.state.account === 'Sign-in required') summary.account = 'Sign-in required';
      this.publish(summary);
    };
    this.unwatchVault = vault.onDidChange(update);
    update();
  }

  async refreshState(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const binding = this.binding();
    this.publish({ binding });
    if (this.runtime && this.vault) {
      const summary = privateSummary(this.vault.snapshot(), binding);
      if (this.state.account === 'Sign-in required') summary.account = 'Sign-in required';
      this.publish(summary);
      return;
    }
    let vault: Vault | undefined;
    try { vault = await Vault.load(this.context.secrets); }
    catch (error) { this.publish({ account: 'Unavailable' }); throw error; }
    if (this.disposed || generation !== this.refreshGeneration || this.runtime) return;
    if (vault) this.observeVault(vault);
    else {
      this.unwatchVault?.(); this.unwatchVault = undefined; this.vault = undefined;
      this.publish(privateSummary(undefined, binding));
    }
  }

  private log(message: string): void { this.output.appendLine(`${new Date().toISOString()} ${message}`); }
  private setStatus(phase: string): void {
    this.status.text = `$(comment-discussion) WeChat AHP: ${phase}`;
    this.publish({
      phase,
      ...(phase === 'Disconnected' ? { agent: 'Unknown', receive: 'Stopped' } : {}),
      ...(phase === 'Connecting' ? { lastPollAt: undefined } : {}),
    });
  }

  private trusted(): string {
    assertLocalDesktop({ remoteName: vscode.env.remoteName });
    if (!vscode.workspace.isTrusted) throw new SafeError('Trust this local workspace in VS Code before enabling a remote-control channel.');
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length || folders.some(folder => folder.uri.scheme !== 'file')) {
      throw new SafeError('Open the agent session\'s trusted local folder first. Empty/virtual workspaces are unsupported.');
    }
    return hash(JSON.stringify(folders.map(folder => folder.uri.toString()).sort()));
  }

  private roots(): string[] { return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []; }

  private binding(): Binding | undefined {
    const value = this.context.globalState.get<unknown>(BINDING_KEY);
    if (value === undefined) return undefined;
    return parseBinding(value);
  }

  private async exclusive(work: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    if (this.operation) throw new SafeError('Another WeChat AHP operation is active. Use Disconnect to cancel it.');
    const operation = new AbortController();
    this.operation = operation;
    this.publish();
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    this.operationDone = done;
    try { await work(operation.signal); }
    catch (error) {
      if (operation.signal.aborted) this.log('Operation cancelled; no automatic retry.');
      else throw error;
    } finally {
      if (this.operation === operation) this.operation = undefined;
      if (this.operationDone === done) this.operationDone = undefined;
      this.publish();
      finished();
    }
  }

  private async pick<T extends vscode.QuickPickItem>(
    items: T[], options: vscode.QuickPickOptions, signal: AbortSignal,
  ): Promise<T | undefined> {
    const source = new vscode.CancellationTokenSource();
    const abort = () => source.cancel();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) source.cancel();
      return await vscode.window.showQuickPick(items, { ...options, canPickMany: false }, source.token);
    } finally { signal.removeEventListener('abort', abort); source.dispose(); }
  }

  private async idleLock<T>(work: () => Promise<T>): Promise<T> {
    if (this.runtime) throw new SafeError('Disconnect this channel before changing account, binding or journal.');
    const lock = await OwnerLock.acquire();
    try { return await work(); }
    finally { await lock.close(); }
  }

  private async signIn(signal: AbortSignal): Promise<void> {
    this.trusted();
    await this.idleLock(async () => {
      const existing = await Vault.load(this.context.secrets);
      if (await vscode.window.showWarningMessage(
        'Sign in to Weixin using your own account. Only the QR-confirmed owner can control the selected agent chat. No polling starts yet.',
        { modal: true }, 'Show QR',
      ) !== 'Show QR') return;
      signal.throwIfAborted();
      const cancel = new AbortController();
      const lifetime = AbortSignal.any([signal, cancel.signal]);
      const panel = vscode.window.createWebviewPanel('wechatAHP.login', 'WeChat AHP: Scan QR', vscode.ViewColumn.Active, {
        enableScripts: false, localResourceRoots: [], retainContextWhenHidden: false,
      });
      const disposed = panel.onDidDispose(() => cancel.abort());
      try {
        const credentials = await login({
          qr: async content => { panel.webview.html = qrHtml(await QRCode.toDataURL(content, { width: 280, margin: 2, errorCorrectionLevel: 'M' })); },
          verify: async current => {
            const source = new vscode.CancellationTokenSource();
            const abort = () => source.cancel();
            current.addEventListener('abort', abort, { once: true });
            try {
              if (current.aborted) source.cancel();
              const code = await vscode.window.showInputBox({
                title: 'WeChat verification', prompt: 'Enter the numeric verification code shown by WeChat.',
                password: true, ignoreFocusOut: true,
                validateInput: value => /^\d{1,12}$/.test(value) ? undefined : 'Use 1-12 digits.',
              }, source.token);
              if (code === undefined) throw new SafeError('Verification cancelled.');
              return code;
            } finally { current.removeEventListener('abort', abort); source.dispose(); }
          },
          log: message => this.log(message),
        }, lifetime);
        lifetime.throwIfAborted();
        if (existing) {
          const previous = existing.snapshot().credentials;
          if (previous.botId !== credentials.botId || previous.ownerId !== credentials.ownerId) {
            throw new SafeError('QR identifies a different account/owner. Existing journal retained; explicitly Sign out before changing accounts.');
          }
          await existing.update(next => { next.credentials = credentials; });
        } else await Vault.create(this.context.secrets, credentials);
        this.publish({ account: 'Signed in' });
        this.log('QR-confirmed owner saved to VS Code SecretStorage.');
        void vscode.window.showInformationMessage('WeChat AHP: Signed in. Select an existing chat, then Connect.');
      } catch (error) {
        if (lifetime.aborted) this.log('QR login cancelled or expired; existing credentials retained.');
        else throw error;
      } finally {
        disposed.dispose();
        panel.dispose();
      }
    });
  }

  async bindChat(node: CatalogChat, connectAfter: boolean): Promise<void> {
    if (!node.eligible) throw new SafeError(node.unavailableReason ?? 'This chat cannot be bound.');
    await this.exclusive(async signal => {
      const saved = await this.selectChat(signal, node);
      if (saved && connectAfter) await this.connect(signal);
    });
  }

  private async selectChat(signal: AbortSignal, target?: CatalogChat): Promise<boolean> {
    let stage = 'workspace trust';
    const step = <T>(name: string, work: () => T): T => {
      stage = name;
      this.log(`Select chat: ${name}.`);
      signal.throwIfAborted();
      return work();
    };
    try {
      const workspace = step('workspace trust', () => this.trusted());
      const saved = await step('window ownership', () => this.idleLock(async () => {
        const hosts = await step('host discovery', () => discoverHosts(undefined, message => this.log(message)));
        if (!hosts.length) throw new SafeError('No local Agent Host endpoint found. Open a supported AHP-backed conversation first. Installing this extension does not create a Host/provider; ordinary chat windows may not expose AHP.');
        const selected = target
          ? hosts.filter(host => host.id === target.hostId).map(host => ({ host }))[0]
          : await step('host selection', () => this.pick(hosts.map(host => ({
          label: `${host.product} / PID ${host.pid}`, description: host.id,
          detail: `Local ${host.endpoint.type}; AHP ${label(host.protocolVersion)}`, host,
        })), { title: 'Select the exact running local Agent Host', ignoreFocusOut: true }, signal));
        if (!selected) {
          if (target) throw new SafeError('The selected Host is no longer available. Refresh Sessions.');
          return;
        }
        const connection = await step('AHP initialize', () => HostConnection.connect(selected.host, signal));
        try {
          const sessions = await step('session catalog', () => connection.listSessions(signal));
          if (!sessions.length) throw new SafeError('This Host exposes no existing sessions. Create a conversation in its VS Code UI first.');
          const session = target
            ? sessions.filter(item => item.resource === target.session).map(item => ({ item }))[0]
            : await step('session selection', () => this.pick(sessions.map(item => ({
            label: label(item.title) || '(untitled)', description: item.resource,
            detail: `Provider: ${label(item.provider)}; select by exact URI, not title alone.`, item,
          })), { title: 'Select an EXISTING session (no new conversation is created)', ignoreFocusOut: true }, signal));
          if (!session) {
            if (target) throw new SafeError('The selected session is no longer in this Host catalog.');
            return;
          }
          const state = await step('session snapshot', () => connection.session(session.item.resource, signal));
          const chats = state.chats.filter(item => !item.interactivity || item.interactivity === 'full');
          if (!chats.length) throw new SafeError('Selected session has no interactive chats. Open its chat in VS Code first.');
          const chat = target
            ? chats.filter(item => item.resource === target.resource).map(item => ({ item }))[0]
            : await step('chat selection', () => this.pick(chats.map(item => ({
            label: label(item.title) || '(untitled)', description: item.resource,
            detail: item.resource === state.defaultChat ? 'Default chat in this existing session' : 'Existing chat in this session', item,
          })), { title: 'Select the exact existing chat', ignoreFocusOut: true }, signal));
          if (!chat) {
            if (target) throw new SafeError('The selected chat is no longer interactive or available.');
            return;
          }
          await step('workspace scope', () => assertSessionScope(state, chat.item.resource, this.roots()));
          const binding = step('binding validation', () => parseBinding({
            hostId: selected.host.id, session: session.item.resource, chat: chat.item.resource, workspace,
          }));
          const vault = await step('private journal', () => Vault.load(this.context.secrets));
          const privateState = vault?.snapshot();
          if (privateState?.messages.some(message => message.binding !== bindingKey(binding) && message.delivery !== 'closed')
            || privateState?.outbox.some(entry => entry.binding !== bindingKey(binding)
              && ['waiting', 'pending', 'sending'].includes(entry.status))) {
            throw new SafeError('Previous binding has pending journal entries. Inspect that chat and use Clear Pending Journal before switching; old replies will never be rerouted.');
          }
          if (await step('binding confirmation', () => vscode.window.showWarningMessage(
            `Bind WeChat AHP to this existing conversation?\nHost: ${binding.hostId}\nSession: ${binding.session}\nChat: ${binding.chat}\nIts working directories are inside this trusted workspace.`,
            { modal: true }, 'Save Binding',
          )) !== 'Save Binding') return;
          signal.throwIfAborted();
          if (this.trusted() !== workspace) throw new SafeError('Workspace changed; binding not saved.');
          await step('binding save', () => this.context.globalState.update(BINDING_KEY, binding));
          this.publish({ binding });
          this.log('Explicit host/session/chat binding saved. No Host token persisted.');
          return true;
        } finally { await connection.close(); }
      }));
      return saved ?? false;
    } catch (error) {
      signal.throwIfAborted();
      throw selectionFailure(stage, error);
    }
  }

  private async connect(signal: AbortSignal): Promise<void> {
    if (this.runtime) { this.log('Channel is already connected/connecting.'); return; }
    const workspace = this.trusted();
    const binding = this.binding();
    if (!binding) throw new SafeError('Select Existing Host / Session / Chat before connecting.');
    if (binding.workspace !== workspace) throw new SafeError('Binding belongs to another workspace. Open that trusted local workspace or select a new binding.');
    if (await vscode.window.showWarningMessage(
      `Enable TWO-WAY TEXT SYNC with your QR-confirmed WeChat owner?\n${binding.hostId}\n${binding.session}\n${binding.chat}\nNew VS Code user messages and completed assistant text from THIS chat will automatically be sent to WeChat. WeChat text enters this chat unchanged. No history, reasoning, tools, attachments or other chats are copied. Tool approvals stay in VS Code. A message from WeChat is needed to establish reply context.`,
      { modal: true }, 'Connect',
    ) !== 'Connect') return;
    signal.throwIfAborted();
    this.lock = await OwnerLock.acquire();
    try {
      const vault = await Vault.load(this.context.secrets);
      if (!vault) throw new SafeError('Sign in with QR first.');
      const credentials = vault.snapshot().credentials;
      this.publish({ binding, lastError: undefined });
      this.observeVault(vault);
      const runtime = new ChannelRuntime({
        binding, vault, api: new WeixinApi(credentials.base, credentials.token),
        resolveHost: () => resolveHost(binding.hostId, message => this.log(message)),
        assertAllowed: () => {
          if (this.trusted() !== binding.workspace) throw new SafeError('Trusted workspace changed; channel stopped.');
        },
        assertScope: session => assertSessionScope(session, binding.chat, this.roots()),
        log: message => this.log(message), status: phase => this.setStatus(phase),
        health: update => this.publish(update),
        failed: message => {
          this.log(message);
          this.publish({ lastError: message });
          void vscode.window.showErrorMessage(`WeChat AHP: ${message}`);
        },
      });
      this.runtime = runtime;
      this.publish();
      const cancel = () => { void runtime.stop().catch(error => this.log(diagnostic(error))); };
      signal.addEventListener('abort', cancel, { once: true });
      const start = runtime.start();
      this.releasing = runtime.finished.finally(async () => {
        signal.removeEventListener('abort', cancel);
        if (this.runtime === runtime) {
          this.runtime = undefined;
          const lock = this.lock;
          this.lock = undefined;
          await lock?.close();
          this.publish();
        }
      });
      void this.releasing.catch(error => this.log(diagnostic(error)));
      if (signal.aborted) cancel();
      await start;
    } catch (error) {
      await this.shutdownChannel();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const done = this.operationDone;
    this.operation?.abort();
    try { await this.shutdownChannel(); }
    finally { await done; }
  }

  private async shutdownChannel(): Promise<void> {
    const runtime = this.runtime;
    if (runtime) await runtime.stop();
    await this.releasing;
    this.releasing = undefined;
    this.runtime = undefined;
    const lock = this.lock;
    this.lock = undefined;
    await lock?.close();
    this.setStatus('Disconnected');
  }

  private async clearPending(signal: AbortSignal): Promise<void> {
    this.trusted();
    await this.idleLock(async () => {
      const vault = await Vault.load(this.context.secrets);
      if (!vault) throw new SafeError('No private journal exists.');
      if (await vscode.window.showWarningMessage(
        'After inspecting the original VS Code chat, close ALL pending local delivery/reply routes without resending? Host turns are not cancelled. Sent/uncertain history and deduplication IDs are preserved.',
        { modal: true }, 'Close Pending Routes',
      ) !== 'Close Pending Routes') return;
      signal.throwIfAborted();
      await vault.update(next => {
        signal.throwIfAborted();
        for (const message of next.messages) {
          message.delivery = 'closed';
          message.contextToken = '';
          message.text = '';
          if (message.outbound?.status === 'sending') message.outbound.status = 'uncertain';
        }
        for (const entry of next.outbox) {
          if (entry.status === 'sending') entry.status = 'uncertain';
          if (entry.status === 'waiting' || entry.status === 'pending') entry.status = 'cancelled';
          entry.text = '';
          entry.route = undefined;
          entry.parts = undefined;
          entry.updatedAt = Date.now();
        }
        next.sync = undefined;
        next.peer = undefined;
      });
      this.log('Pending routes explicitly closed by user; no messages resent and send history retained.');
    });
  }

  private async logout(signal: AbortSignal): Promise<void> {
    await this.idleLock(async () => {
      if (await vscode.window.showWarningMessage(
        'Delete this extension\'s account, private journal and binding? This forgets deduplication and uncertain send history; old service messages might reappear after a new login. It does not revoke credentials server-side or cancel Host turns.',
        { modal: true }, 'Delete Local Channel State',
      ) !== 'Delete Local Channel State') return;
      signal.throwIfAborted();
      await this.context.secrets.delete(SECRET_KEY);
      await this.context.globalState.update(BINDING_KEY, undefined);
      this.log('Local account, journal and binding deleted by user. No server-side revocation claimed.');
    });
  }

  private async showStatus(): Promise<void> {
    await this.showDiagnostics();
    const selected = await vscode.window.showQuickPick([
      { label: 'Sign in with QR', command: 'login' },
      { label: 'Select Existing Host / Session / Chat', command: 'selectChat' },
      { label: 'Connect', command: 'connect' }, { label: 'Disconnect', command: 'disconnect' },
      { label: 'Clear Pending Journal (No Resend)', command: 'clearPending' },
      { label: 'Sign out and Clear Channel State', command: 'logout' },
    ], { title: `WeChat AHP: ${this.state.phase}` });
    if (selected) await vscode.commands.executeCommand(`wechatAHP.${selected.command}`);
  }

  async showDiagnostics(copy = false): Promise<void> {
    await this.refreshState();
    const state = this.snapshot();
    const text = [
      `WeChat AHP ${this.context.extension.packageJSON.version}`,
      `Supported AHP versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
      `Account: ${state.account}`, `Owner alias: ${state.ownerAlias ?? 'None'}`,
      `AHP: ${state.phase}`, `Receive: ${state.receive}`, `Send: ${sendStatus(state)}`, `Agent: ${state.agent}`,
      `Host: ${state.binding?.hostId ?? 'Not bound'}`, `Session: ${state.binding?.session ?? 'Not bound'}`,
      `Chat: ${state.binding?.chat ?? 'Not bound'}`, `Waiting: ${state.waiting}`, `Queued: ${state.pending}`,
      `Uncertain: ${state.uncertain}`, `Last error: ${state.lastError ?? 'None'}`,
      'No message bodies, credentials or private reply contexts are included.',
    ].join('\n');
    if (copy) { await vscode.env.clipboard.writeText(text); return; }
    this.output.appendLine(text);
    this.output.show(true);
  }

  async showDeliveries(): Promise<void> {
    await this.refreshState();
    const recent = this.state.recent;
    if (!recent.length) { void vscode.window.showInformationMessage('No recent deliveries for the current binding.'); return; }
    await vscode.window.showQuickPick(recent.map(entry => ({
      label: `${entry.direction} / ${entry.role}`,
      description: entry.status,
      detail: `${entry.time ? new Date(entry.time).toLocaleString('en-US') : 'Time unavailable'}${entry.confirmedParts !== undefined ? ` / ${entry.confirmedParts} part(s) accepted` : ''}`,
    })), { title: 'Recent Deliveries (metadata only; no automatic resend)', ignoreFocusOut: true });
  }

  async dispose(): Promise<void> {
    try { await this.stop(); }
    finally {
      this.disposed = true;
      this.catalog.dispose();
      this.unwatchVault?.();
    }
  }
}
