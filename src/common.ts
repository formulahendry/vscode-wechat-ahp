import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const VERSION = '0.1.3';
export const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
export const MAX_TEXT_BYTES = 16 * 1024;
export const MAX_PENDING = 32;
export const MAX_RECORDS = 128;
export const MAX_SEEN = 2048;

export class SafeError extends Error {
  constructor(message: string, readonly retryable = false, readonly kind = 'local') {
    super(message);
  }
}

export function diagnostic(error: unknown): string {
  // Raw network errors, response bodies and schema failures can contain credentials.
  return error instanceof SafeError ? error.message : 'Unexpected local failure; sensitive details withheld.';
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0)
    && Buffer.byteLength(value) <= max && value.isWellFormed();
}

export function identifier(value: unknown): value is string {
  return boundedString(value, 256) && !/[\s\p{C}]/u.test(value);
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function apiBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new SafeError('Invalid Weixin API origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash || value.includes('\\')
    || !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(url.hostname)) {
    throw new SafeError('Unapproved Weixin origin. Only HTTPS ilink*.weixin.qq.com on the default port is allowed.');
  }
  return url.origin;
}

export function redirectBase(value: unknown): string {
  if (!boundedString(value, 253) || !/^[a-z0-9.-]+$/.test(value)) {
    throw new SafeError('Invalid QR redirect host.');
  }
  return apiBase(`https://${value}`);
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal });
}

export function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export function retryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

export function nodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function chunks(text: string, maxBytes = 3500): string[] {
  if (!boundedString(text, MAX_TEXT_BYTES) || !text.trim()) {
    throw new SafeError('Reply must be nonempty well-formed text, at most 16 KiB.');
  }
  if (maxBytes < 4) throw new SafeError('Chunk size must allow one Unicode code point.');
  const result: string[] = [];
  let current = '';
  let length = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point);
    if (length + size > maxBytes) {
      result.push(current);
      current = '';
      length = 0;
    }
    current += point;
    length += size;
  }
  if (current) result.push(current);
  return result;
}
