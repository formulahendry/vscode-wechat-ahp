import { WeixinApi } from './weixin.js';
import {
  apiBase, boundedString, DEFAULT_BASE, diagnostic, identifier, pause, redirectBase, retryDelay, SafeError,
} from './common.js';
import type { Credentials } from './storage.js';

export interface LoginUi {
  qr(content: string): Promise<void>;
  verify(signal: AbortSignal): Promise<string>;
  log(message: string): void;
}

export async function login(
  ui: LoginUi, signal: AbortSignal, makeApi = (base: string) => new WeixinApi(base), wait = pause,
): Promise<Credentials> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  let api = makeApi(DEFAULT_BASE);
  const qr = await api.request('ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, lifetime);
  if (!boundedString(qr.qrcode, 4096) || !boundedString(qr.qrcode_img_content, 2048)) {
    throw new SafeError('Invalid QR response.');
  }
  await ui.qr(qr.qrcode_img_content);
  let code: string | undefined;
  let verifyAttempts = 0;
  let redirects = 0;
  let failures = 0;
  while (!lifetime.aborted) {
    let status: Record<string, unknown>;
    try {
      status = await api.request(
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`,
        undefined, lifetime, 35_000,
      );
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      if (lifetime.aborted) throw new SafeError('QR login timed out. Sign in again.');
      if (!(error instanceof SafeError) || !error.retryable || ++failures > 5) throw error;
      ui.log(`${diagnostic(error)} Retrying QR status (${failures}/5).`);
      await wait(retryDelay(failures), lifetime);
      continue;
    }
    switch (status.status) {
      case 'wait': break;
      case 'scaned':
        code = undefined;
        ui.log('QR scanned; confirm in WeChat.');
        break;
      case 'need_verifycode':
        if (++verifyAttempts > 3) throw new SafeError('Verification attempt limit reached. Sign in again.');
        code = await ui.verify(lifetime);
        if (!/^\d{1,12}$/.test(code)) throw new SafeError('Verification code must be 1-12 digits.');
        continue;
      case 'scaned_but_redirect':
        if (++redirects > 3) throw new SafeError('QR redirect limit reached.');
        api = makeApi(redirectBase(status.redirect_host));
        break;
      case 'confirmed': {
        if (!boundedString(status.bot_token, 8192) || /[\r\n]/.test(status.bot_token)
          || !identifier(status.ilink_bot_id)) throw new SafeError('Login response lacks valid bot credentials.');
        if (!identifier(status.ilink_user_id) || status.ilink_user_id === status.ilink_bot_id) {
          throw new SafeError('QR response lacks a reliable owner identity. Credentials NOT saved; first-sender pairing is disabled.');
        }
        if (status.baseurl !== undefined && typeof status.baseurl !== 'string') {
          throw new SafeError('Invalid login API origin.');
        }
        return {
          botId: status.ilink_bot_id, ownerId: status.ilink_user_id, token: status.bot_token,
          base: status.baseurl === undefined ? api.base : apiBase(status.baseurl),
        };
      }
      case 'expired': throw new SafeError('QR expired. Sign in again.');
      case 'verify_code_blocked': throw new SafeError('Verification blocked by Weixin. Wait before signing in again.');
      case 'binded_redirect': throw new SafeError('Weixin reports an existing binding but issued no credentials. Existing credentials were kept.');
      default: throw new SafeError('Unknown QR status; login stopped.');
    }
    await wait(1000, lifetime);
  }
  throw new SafeError('QR login timed out after five minutes.');
}
