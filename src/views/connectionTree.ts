import * as vscode from 'vscode';
import type { ChannelController } from '../channelController.js';
import { sendStatus, type ChannelState } from '../channelState.js';

export interface ConnectionRow {
  id: string; title: string; value: string; icon: string; tooltip?: string; context?: string; children?: ConnectionRow[];
}

export function connectionRows(state: ChannelState): ConnectionRow[] {
  const recent: ConnectionRow[] = state.recent.map(entry => ({
    id: entry.id, title: `${entry.direction} / ${entry.role}`, value: entry.status,
    icon: entry.status === 'uncertain' ? 'warning' : 'arrow-swap',
    tooltip: [
      entry.direction, entry.role, entry.status,
      entry.time ? new Date(entry.time).toLocaleString('en-US') : 'Time unavailable',
      ...(entry.confirmedParts !== undefined ? [`${entry.confirmedParts} part(s) accepted by the API; not a read receipt.`] : []),
    ].join('\n'),
  }));
  return [
    { id: 'account', title: 'WeChat account', value: `${state.account}${state.ownerAlias ? ` / ${state.ownerAlias}` : ''}`, icon: 'account' },
    { id: 'ahp', title: 'Agent Host', value: state.phase, icon: state.phase === 'Connected' ? 'plug' : 'debug-disconnect' },
    { id: 'binding', title: 'Bound chat', value: state.binding?.chat ?? 'Not selected', icon: 'pinned',
      tooltip: state.binding ? `Host: ${state.binding.hostId}\nSession: ${state.binding.session}\nChat: ${state.binding.chat}` : 'Select an existing local chat in Sessions.', context: 'wechatBindingStatus' },
    { id: 'receive', title: 'WeChat receive', value: state.receive, icon: state.receive.startsWith('Retrying') ? 'warning' : 'arrow-down' },
    { id: 'send', title: 'WeChat send', value: sendStatus(state), icon: state.uncertain ? 'warning' : 'arrow-up', context: 'wechatQueueStatus' },
    { id: 'agent', title: 'Agent', value: state.agent, icon: state.agent === 'Awaiting input' ? 'question' : 'comment-discussion',
      tooltip: 'Agent activity is independent of channel health. Approve tools only in the original VS Code chat.' },
    { id: 'inbox', title: 'Pending inbound', value: String(state.pendingInbound), icon: 'inbox', context: 'wechatQueueStatus' },
    { id: 'waiting', title: 'Waiting for reply context', value: String(state.waiting), icon: 'clock', context: 'wechatQueueStatus' },
    { id: 'pending', title: 'Queued outbound', value: String(state.pending), icon: 'list-ordered', context: 'wechatQueueStatus' },
    { id: 'uncertain', title: 'Uncertain delivery', value: String(state.uncertain), icon: state.uncertain ? 'warning' : 'check',
      tooltip: 'Inspect WeChat and the original chat. Uncertain sends are never automatically retried.', context: 'wechatQueueStatus' },
    { id: 'activity', title: 'Last activity', value: state.lastActivity ? new Date(state.lastActivity).toLocaleTimeString('en-US') : 'None', icon: 'history' },
    { id: 'poll', title: 'Last successful poll', value: state.lastPollAt ? new Date(state.lastPollAt).toLocaleTimeString('en-US') : 'None', icon: 'pulse' },
    { id: 'recent', title: 'Recent deliveries', value: String(recent.length), icon: 'history', children: recent },
    ...(state.lastError ? [{ id: 'error', title: 'Last error', value: state.lastError, tooltip: state.lastError, icon: 'error', context: 'wechatDiagnosticStatus' }] : []),
  ];
}

export class ConnectionTree implements vscode.TreeDataProvider<ConnectionRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ConnectionRow | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly listener: vscode.Disposable;
  private timer?: NodeJS.Timeout;

  constructor(private readonly controller: ChannelController) {
    this.listener = controller.onDidChange(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.changed.fire(undefined); }, 150);
    });
  }
  getChildren(node?: ConnectionRow): ConnectionRow[] { return node?.children ?? (node ? [] : connectionRows(this.controller.snapshot())); }
  getTreeItem(node: ConnectionRow): vscode.TreeItem {
    const item = new vscode.TreeItem(node.title, node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = node.id; item.description = node.value; item.tooltip = node.tooltip ?? `${node.title}: ${node.value}`;
    item.iconPath = new vscode.ThemeIcon(node.icon); item.contextValue = node.context ?? 'wechatConnectionStatus';
    return item;
  }
  dispose(): void { this.listener.dispose(); clearTimeout(this.timer); this.changed.dispose(); }
}
