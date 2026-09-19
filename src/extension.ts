import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';
import { ChannelController } from './channelController.js';
import { Telemetry, telemetryFetcher } from './telemetry.js';
import { registerViews } from './views/registerViews.js';

let active: ChannelController | undefined;
let telemetry: Telemetry | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const started = performance.now();
  telemetry = new Telemetry(
    warn => new TelemetryReporter('37e731fc-21aa-4ee5-987a-c3eea6995bb9', undefined,
      { ignoreUnhandledErrors: true }, telemetryFetcher(warn)),
    message => console.warn(message),
  );
  try {
    active = new ChannelController(context, telemetry);
    registerViews(context, active);
    telemetry.activated(performance.now() - started);
  } catch (error) {
    telemetry.error('extension.activation.error', error, performance.now() - started);
    void deactivate().catch(() => console.warn('WeChat AHP: initialization cleanup failed.'));
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  const controller = active;
  const reporter = telemetry;
  active = undefined;
  telemetry = undefined;
  try { await controller?.dispose(); }
  finally { await reporter?.dispose(); }
}
