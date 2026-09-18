import { createServer, type Server } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { hash, nodeCode, SafeError } from './common.js';

export type OwnerLockAddress = string | { host: '127.0.0.1'; port: number };

export function ownerLockAddress(
  platform: NodeJS.Platform = process.platform, uid = userInfo().uid, home = homedir(), username = userInfo().username,
): OwnerLockAddress {
  if (platform === 'win32') {
    // Preserve the original pipe identity so old and new Windows builds still exclude each other.
    return `\\\\.\\pipe\\wechat-ahp-owner-${hash(`${home.toLowerCase()}\0${username.toLowerCase()}`).slice(0, 32)}`;
  }
  if ((platform !== 'darwin' && platform !== 'linux') || !Number.isSafeInteger(uid) || uid < 0) {
    throw new SafeError('Cannot establish the native desktop user identity for the channel lock.');
  }
  // A kernel-held loopback lease avoids stale Unix socket files and unsafe heartbeat expiry.
  // Never select an alternate port on conflict: that would bypass another active owner.
  return { host: '127.0.0.1', port: 49152 + Number.parseInt(hash(`wechat-ahp-owner\0${uid}`).slice(0, 8), 16) % 16384 };
}

export class OwnerLock {
  private closing?: Promise<void>;
  private constructor(private readonly server: Server, readonly address: OwnerLockAddress) {}

  static acquire(address = ownerLockAddress()): Promise<OwnerLock> {
    if (typeof address === 'string'
      ? process.platform !== 'win32' || !/^\\\\\.\\pipe\\[^\\/]+$/.test(address)
      : address.host !== '127.0.0.1' || !Number.isInteger(address.port) || address.port < 0 || address.port > 65535) {
      return Promise.reject(new SafeError('Invalid local channel lock address.'));
    }
    return new Promise((resolve, reject) => {
      // This listener exchanges no messages, credentials or protocol data.
      const server = createServer(socket => socket.destroy());
      server.once('error', error => reject(new SafeError(
        nodeCode(error, 'EADDRINUSE') || nodeCode(error, 'EACCES')
          ? typeof address === 'string'
            ? 'Another local VS Code window owns WeChat AHP. Disconnect/close it first (including Insiders or another profile).'
            : `The WeChat AHP local owner lock is occupied (127.0.0.1:${address.port}). Disconnect another instance; if none is running, another application may own this port. No alternate lock is used.`
          : 'Cannot acquire the local channel lock. Check current-user permissions.', false, 'lock',
      )));
      server.listen(typeof address === 'string' ? { path: address, exclusive: true } : { ...address, exclusive: true }, () => {
        const actual = server.address();
        if (!actual) {
          server.close();
          reject(new SafeError('The local channel lock did not obtain an address.'));
          return;
        }
        resolve(new OwnerLock(server, typeof actual === 'string' ? actual : { host: '127.0.0.1', port: actual.port }));
      });
    });
  }

  close(): Promise<void> {
    this.closing ??= this.server.listening
      ? new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
      : Promise.resolve();
    return this.closing;
  }
}
