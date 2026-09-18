import * as vscode from 'vscode';
import type { ChannelController } from '../channelController.js';
import { record, SafeError } from '../common.js';
import { selectionFailure } from '../diagnostics.js';
import type { CatalogNode } from '../sessionCatalog.js';
import { SessionsTree } from './sessionsTree.js';
import { ConnectionTree } from './connectionTree.js';

export function registerViews(context: vscode.ExtensionContext, controller: ChannelController): void {
  const sessions = new SessionsTree(controller);
  const connection = new ConnectionTree(controller);
  const sessionsView = vscode.window.createTreeView('wechatAHP.sessions', { treeDataProvider: sessions, showCollapseAll: true });
  const connectionView = vscode.window.createTreeView('wechatAHP.connection', { treeDataProvider: connection });
  context.subscriptions.push(sessions, connection, sessionsView, connectionView);
  const node = (argument: unknown): CatalogNode => {
    const current = record(argument) && typeof argument.id === 'string' ? controller.catalog.node(argument.id) : undefined;
    if (!current) throw new SafeError('This item is no longer in the catalog. Refresh Sessions and select it again.');
    return current;
  };
  const catalogAction = async (work: () => Promise<unknown>) => {
    try { await work(); } catch (error) { throw selectionFailure('catalog action', error); }
  };
  controller.registerCommand('focus', async () => { await vscode.commands.executeCommand('workbench.view.extension.wechatAHP'); });
  controller.registerCommand('refreshSessions', async () => { controller.catalog.refresh(); });
  controller.registerCommand('refreshNode', async argument => { controller.catalog.refresh(node(argument)); });
  controller.registerCommand('loadMoreSessions', async argument => {
    const selected = node(argument);
    if (selected.kind !== 'host') throw new SafeError('Select a Host to load more sessions.');
    await catalogAction(() => controller.catalog.loadMore(selected));
  });
  controller.registerCommand('pingHost', async argument => {
    const selected = node(argument);
    if (selected.kind !== 'host') throw new SafeError('Select a Host to check its connection.');
    await catalogAction(() => controller.catalog.ping(selected));
    void vscode.window.showInformationMessage('Agent Host responded to AHP ping. WeChat sync was not started.');
  });
  for (const [command, connectAfter] of [['bindChat', false], ['bindAndConnect', true]] as const) {
    controller.registerCommand(command, async argument => {
      const selected = node(argument);
      if (selected.kind !== 'chat') throw new SafeError('Select an existing chat to bind.');
      await controller.bindChat(selected, connectAfter);
    });
  }
  controller.registerCommand('revealBinding', async () => {
    const binding = controller.snapshot().binding;
    if (!binding) throw new SafeError('No chat is bound yet.');
    await catalogAction(async () => {
      const selected = await controller.catalog.findBinding(binding);
      await sessionsView.reveal(selected, { select: true, focus: true, expand: true });
    });
  });
  controller.registerCommand('copyResource', async argument => {
    const selected = node(argument);
    if (selected.kind !== 'session' && selected.kind !== 'chat') throw new SafeError('Select a session or chat resource.');
    await vscode.env.clipboard.writeText(selected.resource);
  });
  controller.registerCommand('nodeDetails', async argument => {
    const selected = node(argument);
    const details = selected.kind === 'host' ? [
      ['Host', selected.hostId], ['Product', selected.product], ['PID', String(selected.pid)],
      ['AHP protocol', selected.protocolVersion], ['Local endpoint type', selected.endpointType], ['Catalog health', selected.health],
    ] : selected.kind === 'session' ? [
      ['Session', selected.resource], ['Host', selected.hostId], ['Provider', selected.provider],
    ] : selected.kind === 'chat' ? [
      ['Chat', selected.resource], ['Session', selected.session], ['Host', selected.hostId],
      ['Binding eligibility', selected.unavailableReason ?? 'Available in this trusted workspace'],
      ...selected.workingDirectories.map(path => ['Workspace', path]),
    ] : [['Info', selected.title]];
    await vscode.window.showQuickPick(details.map(([label, detail]) => ({ label: label!, detail })),
      { title: 'AHP Resource Details (read-only)', ignoreFocusOut: true });
  });
  controller.registerCommand('diagnostics', () => controller.showDiagnostics());
  controller.registerCommand('copyDiagnostics', () => controller.showDiagnostics(true));
  controller.registerCommand('recentDeliveries', () => controller.showDeliveries());
  const update = () => {
    const state = controller.snapshot();
    sessionsView.description = state.binding ? 'One chat bound' : 'No chat bound';
    connectionView.description = state.phase;
    connectionView.badge = state.uncertain ? { value: state.uncertain, tooltip: 'Uncertain deliveries (never automatically retried)' } : undefined;
  };
  context.subscriptions.push(controller.onDidChange(update));
  context.subscriptions.push(sessionsView.onDidChangeVisibility(event => {
    if (event.visible) {
      controller.catalog.refresh();
      void controller.refreshState().catch(error => controller.reportError(error));
    }
  }));
  context.subscriptions.push(connectionView.onDidChangeVisibility(event => {
    if (event.visible) void controller.refreshState().catch(error => controller.reportError(error));
  }));
  void controller.refreshState().catch(error => controller.reportError(error));
  update();
}
