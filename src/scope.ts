import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionState } from '@microsoft/agent-host-protocol';
import { SafeError } from './common.js';

export async function assertSessionScope(session: SessionState, chatUri: string, roots: readonly string[]): Promise<void> {
  if (!roots.length || !session.workingDirectories?.length) {
    throw new SafeError('Cannot establish the session workspace. Use a Host that exposes workingDirectories and open that trusted local folder in this VS Code window.');
  }
  let allowed: string[];
  try { allowed = await Promise.all(roots.map(root => realpath(root))); }
  catch { throw new SafeError('Cannot resolve this VS Code workspace folder. Check that its local directory exists and is accessible, then retry.'); }
  const chat = session.chats.find(candidate => candidate.resource === chatUri);
  const directories = [...session.workingDirectories, ...(chat?.workingDirectories ?? [])];
  for (const uri of directories) {
    let path: string;
    try {
      const url = new URL(uri);
      if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) throw new Error('non-local');
      path = await realpath(fileURLToPath(url));
    } catch { throw new SafeError('Session workspace is not an accessible local directory. Remote/WSL/container workspaces are unsupported.'); }
    if (!allowed.some(root => {
      const rel = relative(root, path);
      return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../'));
    })) {
      throw new SafeError('Selected agent can access a different workspace. Open its exact local folder(s), trust them explicitly, then select the session again.');
    }
  }
}
