import { ClientClosedError, RpcError, RpcTimeoutError, TransportError } from '@microsoft/agent-host-protocol/client';
import { SafeError } from './common.js';

export function selectionFailure(stage: string, error: unknown): SafeError {
  const prefix = `Select chat / ${stage}: `;
  if (error instanceof SafeError) return new SafeError(prefix + error.message, error.retryable, error.kind);
  if (error instanceof RpcError) {
    const code = Number.isSafeInteger(error.code) ? ` (${error.code})` : '';
    const hint = error.code === -32601
      ? 'This Host does not support the requested AHP method. Update VS Code/provider or select a compatible Host.'
      : 'The Host rejected the request. Open the selected session in VS Code, check provider sign-in, then select it again.';
    return new SafeError(`${prefix}AHP RPC error${code}. ${hint}`, false, 'ahp-rpc');
  }
  if (error instanceof RpcTimeoutError) {
    return new SafeError(`${prefix}AHP request timed out. Check that the selected Host/session is responsive and retry.`, true, 'transport');
  }
  if (error instanceof ClientClosedError || error instanceof TransportError) {
    return new SafeError(`${prefix}AHP connection closed. Rediscover the Host; its endpoint may have changed.`, true, 'transport');
  }
  const category = error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : 'local error';
  return new SafeError(`${prefix}${category}. Open Status / Diagnostics and report this stage; sensitive details withheld.`);
}
