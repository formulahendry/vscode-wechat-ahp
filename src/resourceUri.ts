import { boundedString } from './common.js';

const nonChannelSchemes = new Set([
  'http:', 'https:', 'ws:', 'wss:', 'file:', 'ftp:', 'ftps:', 'data:', 'javascript:',
  'command:', 'mailto:', 'vscode:', 'vscode-insiders:', 'vscode-remote:', 'ahp-root:',
]);

export function isChannelResourceUri(value: unknown): value is string {
  if (!boundedString(value, 2048) || /[\s\p{C}\\]/u.test(value)
    || !/^[a-z][a-z0-9+.-]*:\/(?!\/\/)/i.test(value)) return false;
  try {
    const uri = new URL(value);
    // These are opaque resources on the selected Host, NOT URLs to fetch.
    // VS Code uses provider session schemes and authority-bearing ahp-chat URIs.
    return !nonChannelSchemes.has(uri.protocol) && !uri.username && !uri.password
      && !uri.search && !uri.hash && !value.includes('?') && !value.includes('#')
      && (uri.hostname.length > 0 || uri.pathname.length > 1);
  } catch { return false; }
}
