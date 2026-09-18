import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { boundedString, nodeCode, record, SafeError } from './common.js';

export type Endpoint = { type: 'tcp'; host: string; port: number } | { type: 'socket'; path: string };
export interface Host {
  id: string;
  product: string;
  pid: number;
  endpoint: Endpoint;
  connectionToken: string;
  protocolVersion: string;
}

export interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  configHome?: string;
}

export function registryDirectories({
  platform = process.platform, home = homedir(), env = process.env, configHome,
}: DiscoveryOptions = {}): { product: string; directory: string }[] {
  const paths = platform === 'win32' ? win32 : posix;
  let root: string;
  if (configHome !== undefined) root = configHome;
  else if (platform === 'win32') {
    if (!env.APPDATA) throw new SafeError('APPDATA is missing. Restore your desktop user environment and retry.');
    root = env.APPDATA;
  } else if (platform === 'darwin') root = posix.join(home, 'Library', 'Application Support');
  else if (platform === 'linux') root = env.XDG_CONFIG_HOME || posix.join(home, '.config');
  else throw new SafeError('Local Agent Host discovery supports Windows, macOS and Linux desktop only.');
  if (!['win32', 'darwin', 'linux'].includes(platform) || !paths.isAbsolute(root)) {
    throw new SafeError('The desktop configuration directory must be an absolute path. Check APPDATA, HOME or XDG_CONFIG_HOME.');
  }
  return ['Code', 'Code - Insiders'].map(product => ({
    product, directory: paths.join(root, product, 'agent-host', 'local-endpoint', 'entries'),
  }));
}

export function isLocalSocketPath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (!boundedString(value, 512) || /[\p{C}]/u.test(value)) return false;
  if (platform === 'win32') return /^\\\\\.\\pipe\\[^\\/]+$/i.test(value);
  return (platform === 'darwin' || platform === 'linux') && posix.isAbsolute(value)
    && !value.startsWith('//') && !value.includes('\\') && value !== '/';
}

export function parseEndpoint(value: unknown, product: string, platform: NodeJS.Platform = process.platform): Host | undefined {
  if (!record(value) || value.schemaVersion !== 2
    || (value.type !== 'editor' && value.type !== 'standalone')
    || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !boundedString(value.instanceId, 256) || !/^[\w.-]+$/.test(value.instanceId)
    || !boundedString(value.protocolVersion, 64) || !/^\d+\.\d+\.\d+$/.test(value.protocolVersion)
    || !boundedString(value.connectionToken, 8192) || /[\r\n]/.test(value.connectionToken)
    || !record(value.endpoint)) return undefined;
  const address = value.endpoint;
  let endpoint: Endpoint;
  if (address.type === 'tcp' && typeof address.host === 'string'
    && ['127.0.0.1', '::1', 'localhost'].includes(address.host)
    && typeof address.port === 'number' && Number.isSafeInteger(address.port) && address.port > 0 && address.port <= 65535) {
    endpoint = { type: 'tcp', host: address.host, port: address.port };
  } else if (address.type === 'socket' && isLocalSocketPath(address.path, platform)) {
    endpoint = { type: 'socket', path: address.path };
  } else return undefined;
  return {
    id: `${product}:${value.type}:${value.pid}:${value.instanceId}`, product, pid: value.pid,
    protocolVersion: value.protocolVersion, connectionToken: value.connectionToken, endpoint,
  };
}

export async function discoverHosts(
  options: DiscoveryOptions | string = {}, log: (message: string) => void = () => undefined,
): Promise<Host[]> {
  const settings = typeof options === 'string' ? { configHome: options } : options;
  const platform = settings.platform ?? process.platform;
  const uid = process.getuid?.();
  const hosts = new Map<string, Host>();
  const conflicts = new Set<string>();
  for (const { product, directory } of registryDirectories(settings)) {
    let names: string[];
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()
        || platform !== 'win32' && (uid === undefined || info.uid !== uid || (info.mode & 0o022) !== 0)) {
        log('Skipped an Agent Host registry directory with unsafe ownership or permissions.');
        continue;
      }
      names = await readdir(directory);
    }
    catch (error) {
      if (nodeCode(error, 'ENOENT')) continue;
      throw new SafeError('Cannot read the local Agent Host registry. Check current-user permissions.');
    }
    if (names.length > 512) throw new SafeError('Agent Host registry is unexpectedly large; discovery stopped.');
    for (const name of names.filter(item => item.endsWith('.json'))) {
      try {
        const path = join(directory, name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024
          || platform !== 'win32' && (uid === undefined || info.uid !== uid || (info.mode & 0o022) !== 0)) {
          log('Skipped invalid Agent Host registry entry.');
          continue;
        }
        const host = parseEndpoint(JSON.parse(await readFile(path, 'utf8')), product, platform);
        if (!host) {
          log('Skipped unsupported or non-local Agent Host registry entry.');
          continue;
        }
        try { process.kill(host.pid, 0); }
        catch (error) {
          if (!nodeCode(error, 'EPERM')) {
            log('Skipped stale Agent Host registry entry.');
            continue;
          }
        }
        const existing = hosts.get(host.id);
        if (conflicts.has(host.id)) continue;
        if (existing && JSON.stringify(existing) !== JSON.stringify(host)) {
          hosts.delete(host.id);
          conflicts.add(host.id);
          log('Conflicting registry entries for one Host identity; that Host is unavailable until rediscovery resolves it.');
        } else hosts.set(host.id, host);
      } catch {
        // Registry entries belong to VS Code and can disappear during a restart.
        log('Skipped unreadable or changing Agent Host registry entry.');
      }
    }
  }
  return [...hosts.values()];
}

export async function resolveHost(id: string, log: (message: string) => void): Promise<Host> {
  const matches = (await discoverHosts(undefined, log)).filter(host => host.id === id);
  if (matches.length !== 1) {
    throw new SafeError('The exact bound Host is unavailable or restarted. Select Existing Host / Session / Chat again; no fallback Host was chosen.');
  }
  return matches[0]!;
}
