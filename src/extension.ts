import * as vscode from 'vscode';
import { ChannelController } from './channelController.js';
import { registerViews } from './views/registerViews.js';

let active: ChannelController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  active = new ChannelController(context);
  registerViews(context, active);
}

export async function deactivate(): Promise<void> {
  await active?.dispose();
  active = undefined;
}
