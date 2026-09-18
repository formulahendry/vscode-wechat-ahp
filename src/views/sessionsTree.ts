import * as vscode from 'vscode';
import type { ChannelController } from '../channelController.js';
import { agentStatus } from '../channelState.js';
import type { CatalogNode } from '../sessionCatalog.js';

export class SessionsTree implements vscode.TreeDataProvider<CatalogNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<CatalogNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly unwatch: () => void;
  private readonly stateListener: vscode.Disposable;
  private timer?: NodeJS.Timeout;

  constructor(private readonly controller: ChannelController) {
    this.unwatch = controller.catalog.onDidChange(() => this.refresh());
    this.stateListener = controller.onDidChange(() => this.refresh());
  }

  private refresh(): void {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.changed.fire(undefined); }, 150);
  }

  async getChildren(node?: CatalogNode): Promise<CatalogNode[]> {
    const items = await this.controller.catalog.children(node);
    if (node && items.length === 0) {
      return [{ kind: 'notice', id: `empty-${node.id}`, parentId: node.id, title: node.kind === 'host' ? 'No sessions available' : 'No chats available' }];
    }
    return items;
  }

  getParent(node: CatalogNode): CatalogNode | undefined {
    return 'parentId' in node && node.parentId ? this.controller.catalog.node(node.parentId) : undefined;
  }

  getTreeItem(node: CatalogNode): vscode.TreeItem {
    const state = this.controller.snapshot();
    const item = new vscode.TreeItem(node.title, node.kind === 'host' || node.kind === 'session'
      ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    if (node.kind === 'host') {
      item.contextValue = this.controller.catalog.hasMore(node.hostId) ? 'wechatHostMore' : 'wechatHost';
      item.iconPath = new vscode.ThemeIcon(node.health === 'Unavailable' ? 'warning' : 'server');
      item.description = `${node.endpointType} / ${node.health}${this.controller.catalog.hasMore(node.hostId) ? ' / More available' : ''}`;
      item.tooltip = `${node.title}\nHost: ${node.hostId}\nProtocol: ${node.protocolVersion}\nEndpoint: local ${node.endpointType}\n${node.health}. Browsing does not enable WeChat sync.`;
    } else if (node.kind === 'session') {
      item.contextValue = 'wechatSession';
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.description = `${node.provider} / ${agentStatus(node.status)}`;
      item.tooltip = `${node.title}\nProvider: ${node.provider}\nSession: ${node.resource}\nHost: ${node.hostId}`;
    } else if (node.kind === 'chat') {
      const bound = state.binding?.hostId === node.hostId && state.binding.session === node.session && state.binding.chat === node.resource;
      item.contextValue = node.eligible ? bound ? 'wechatChatBound' : 'wechatChat' : 'wechatChatUnavailable';
      item.iconPath = new vscode.ThemeIcon(!node.eligible ? 'lock' : bound ? 'pinned' : 'comment');
      item.description = `${bound ? 'Bound / ' : ''}${node.eligible ? bound && state.active ? state.agent : agentStatus(node.status) : 'Unavailable in this workspace'}`;
      item.tooltip = [
        node.title, `Chat: ${node.resource}`, `Session: ${node.session}`, `Host: ${node.hostId}`,
        ...(node.unavailableReason ? [node.unavailableReason] : []),
        ...node.workingDirectories.map(path => `Workspace: ${path}`),
        'Use Bind or Bind and Connect explicitly. Selecting a row never changes the binding.',
      ].join('\n');
    } else {
      item.contextValue = 'wechatNotice';
      item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip = node.title;
    }
    return item;
  }

  dispose(): void {
    this.unwatch(); this.stateListener.dispose(); clearTimeout(this.timer); this.changed.dispose();
  }
}
