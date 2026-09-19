import type { CustomFetcher, TelemetryReporter } from '@vscode/extension-telemetry';
import { SafeError } from './common.js';

export const COMMAND_NAMES = [
  'login', 'selectChat', 'connect', 'disconnect', 'status', 'logout', 'clearPending',
  'focus', 'refreshSessions', 'refreshNode', 'loadMoreSessions', 'pingHost', 'bindChat',
  'bindAndConnect', 'revealBinding', 'copyResource', 'nodeDetails', 'diagnostics',
  'copyDiagnostics', 'recentDeliveries',
] as const;
export type CommandName = typeof COMMAND_NAMES[number];
const RESULT_COMMANDS = new Set<CommandName>(['login', 'connect', 'bindAndConnect']);
const ERROR_CATEGORIES = new Set([
  'auth', 'business', 'protocol', 'transport', 'storage', 'delivery', 'lock',
  'ahp-rpc', 'ahp-rejected', 'ambiguous', 'network', 'timeout', 'http', 'local',
]);
type Outcome = 'success' | 'cancelled' | 'failed';
type Reporter = Pick<TelemetryReporter, 'telemetryLevel' | 'sendTelemetryEvent' | 'sendTelemetryErrorEvent' | 'dispose'>;
type ErrorEvent = `wechatAHP.${CommandName}.error` | 'wechatAHP.channel.error' | 'extension.activation.error';
type UsageEvent = `wechatAHP.${CommandName}` | `wechatAHP.${'login' | 'connect' | 'bindAndConnect'}.result` | 'extension.activated';

function duration(value?: number): Record<string, number> | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? { duration_ms: Math.min(Math.round(value), 86_400_000) } : undefined;
}

export class Telemetry {
  private reporter?: Reporter;
  private warned = false;
  private disposing?: Promise<void>;

  constructor(
    factory: (warn: () => void) => Reporter,
    private readonly diagnostic: (message: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {
    try { this.reporter = factory(() => this.warn()); }
    catch { this.warn(); }
  }

  private warn(): void {
    if (this.warned) return;
    this.warned = true;
    this.diagnostic('WeChat AHP: telemetry is unavailable; channel operation is unaffected.');
  }

  private send(error: boolean, event: UsageEvent | ErrorEvent, properties?: Record<string, string>, elapsed?: number): void {
    try {
      const reporter = this.reporter;
      if (!reporter) return;
      // Read the SDK's live effective state, never a workspace-controlled setting.
      if (reporter.telemetryLevel !== 'all' && !(error && reporter.telemetryLevel === 'error')) return;
      if (error) reporter.sendTelemetryErrorEvent(event, properties, duration(elapsed));
      else reporter.sendTelemetryEvent(event, properties, duration(elapsed));
    } catch { this.warn(); }
  }

  activated(elapsed: number): void { this.send(false, 'extension.activated', undefined, elapsed); }

  error(event: ErrorEvent, error: unknown, elapsed?: number): void {
    const allowed = event === 'extension.activation.error' || event === 'wechatAHP.channel.error'
      || COMMAND_NAMES.some(name => event === `wechatAHP.${name}.error`);
    if (!allowed) { this.warn(); return; }
    const category = error instanceof SafeError && ERROR_CATEGORIES.has(error.kind) ? error.kind : 'unexpected';
    this.send(true, event, { error_category: category }, elapsed);
  }

  command(name: CommandName): CommandTelemetry {
    const allowed = COMMAND_NAMES.includes(name);
    if (allowed) this.send(false, `wechatAHP.${name}`);
    else this.warn();
    let started: number | undefined;
    let finished = false;
    let errorReported = false;
    const elapsed = () => started === undefined ? undefined : this.now() - started;
    const finish = (outcome: Outcome) => {
      if (finished || !allowed) return;
      if (outcome !== 'success' && outcome !== 'cancelled' && outcome !== 'failed') { this.warn(); return; }
      finished = true;
      if (name === 'login' || name === 'connect' || name === 'bindAndConnect') {
        this.send(false, `wechatAHP.${name}.result`, { outcome }, elapsed());
      }
    };
    return {
      start: () => { if (!finished && RESULT_COMMANDS.has(name)) started ??= this.now(); },
      finish,
      fail: error => {
        if (errorReported || !allowed) return;
        errorReported = true;
        finish('failed');
        this.error(`wechatAHP.${name}.error`, error, elapsed());
      },
    };
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    const reporter = this.reporter;
    this.reporter = undefined;
    this.disposing = (async () => {
      if (!reporter) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => reporter.dispose()),
          new Promise<void>(resolve => { timer = setTimeout(() => { this.warn(); resolve(); }, 1500); }),
        ]);
      } catch { this.warn(); }
      finally { if (timer) clearTimeout(timer); }
    })();
    return this.disposing;
  }
}

export interface CommandTelemetry {
  start(): void;
  finish(outcome: Outcome): void;
  fail(error: unknown): void;
}

// The SDK's Node HTTPS fallback lacks a request-error handler. Its supported
// fetcher hook handles rejected requests and lets us bound network shutdown.
export function telemetryFetcher(warn: () => void, request: typeof fetch = fetch): CustomFetcher {
  return async (url, init) => {
    try {
      const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) warn();
      const headers: [string, string][] = [];
      response.headers.forEach((value, key) => headers.push([key, value]));
      const text = await response.text();
      return { status: response.status, headers, text: async () => text };
    } catch {
      warn();
      throw new Error('Telemetry request failed.');
    }
  };
}
