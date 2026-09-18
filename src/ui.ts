import { randomBytes } from 'node:crypto';

export function qrHtml(image: string): string {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image)) throw new Error('Expected a locally generated PNG.');
  const nonce = randomBytes(18).toString('base64');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">body{font-family:var(--vscode-font-family);padding:24px;line-height:1.6;color:var(--vscode-foreground);background:var(--vscode-editor-background)}img{max-width:100%;background:white;border:12px solid white}p{max-width:560px}</style>
</head><body><h1>WeChat AHP sign-in</h1>
<p>Scan with your own WeChat account and confirm on your phone. That authenticated account becomes the only authorized owner.</p>
<img src="${image}" width="280" height="280" alt="WeChat login QR code">
<p>This QR expires within five minutes. Closing this panel cancels login. No message polling starts until you select an existing chat and explicitly Connect.</p>
</body></html>`;
}

export function label(text: string): string {
  return text.replace(/[\p{C}]/gu, ' ').replace(/\$\(/g, '(').slice(0, 180);
}
