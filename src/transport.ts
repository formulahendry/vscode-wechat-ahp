import { Agent } from 'node:http';
import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { TransportError, type AhpTransport, type JsonRpcMessage, type TransportFrame } from '@microsoft/agent-host-protocol/client';
import WebSocket, { type RawData } from 'ws';
import { nodeCode, SafeError } from './common.js';
import { isLocalSocketPath, type Host } from './endpoints.js';

interface Waiter {
  resolve(frame: TransportFrame | null): void;
  reject(error: Error): void;
}

// Adapted from ahp-channels' MIT SocketWebSocketTransport; see third-party notices.
class LocalAgent extends Agent {
  constructor(private readonly target: Host['endpoint']) { super({ keepAlive: false }); }
  override createConnection(): Socket {
    if (this.target.type === 'socket') return createConnection(this.target.path);
    return createConnection({ host: this.target.host === 'localhost' ? '127.0.0.1' : this.target.host, port: this.target.port });
  }
}

export class LocalTransport implements AhpTransport {
  private readonly inbox: TransportFrame[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private error?: TransportError;
  private buffered = 0;

  static async connect(host: Host, signal: AbortSignal): Promise<LocalTransport> {
    signal.throwIfAborted();
    if (host.endpoint.type === 'socket') {
      if (!isLocalSocketPath(host.endpoint.path)) throw new SafeError('Host IPC address is not a supported local socket.');
      if (process.platform !== 'win32') {
        try {
          const info = await lstat(host.endpoint.path);
          if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
            throw new SafeError('Host Unix socket is not owned by the current user. Rediscover a local Host.');
          }
        } catch (error) {
          if (error instanceof SafeError) throw error;
          throw new SafeError(nodeCode(error, 'ENOENT')
            ? 'Host Unix socket disappeared. Rediscover the running Host.'
            : 'Cannot inspect the Host Unix socket. Check current-user permissions.', true, 'transport');
        }
      }
    }
    signal.throwIfAborted();
    const url = new URL('ws://localhost/');
    url.searchParams.set('tkn', host.connectionToken);
    // Supplying an Agent (not only createConnection in options) bypasses VS Code's proxy shims.
    const agent = new LocalAgent(host.endpoint);
    const socket = new WebSocket(url, {
      agent, handshakeTimeout: 10_000, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024,
    });
    return new Promise((resolve, reject) => {
      const abort = () => {
        socket.terminate();
        fail(signal.reason);
      };
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        socket.off('open', opened);
        socket.off('error', failed);
        socket.off('close', earlyClose);
      };
      const fail = (error: unknown) => {
        cleanup();
        socket.on('error', () => undefined);
        socket.terminate();
        agent.destroy();
        reject(error);
      };
      const opened = () => { cleanup(); resolve(new LocalTransport(socket)); };
      const failed = () => fail(new SafeError('Local Agent Host WebSocket failed. Rediscover the Host; its token or endpoint may have changed.', true, 'transport'));
      const earlyClose = () => fail(new SafeError('Agent Host closed before the connection opened.', true, 'transport'));
      socket.once('close', () => agent.destroy());
      socket.once('open', opened);
      socket.once('error', failed);
      socket.once('close', earlyClose);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      const bytes = rawBytes(data);
      this.deliver(isBinary ? { kind: 'binary', data: bytes } : { kind: 'text', text: bytes.toString('utf8') });
    });
    socket.on('error', () => this.fail(new TransportError('io', 'Local Agent Host transport failed.')));
    socket.on('close', code => {
      this.closed = true;
      if (code !== 1000 && code !== 1005) this.fail(new TransportError('closed', 'Local Agent Host disconnected.'));
      else for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
    });
  }

  send(message: JsonRpcMessage | string): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new TransportError('closed', 'Local transport is closed.'));
    }
    return new Promise((resolve, reject) => {
      this.socket.send(typeof message === 'string' ? message : JSON.stringify(message), error => {
        if (error) reject(new TransportError('io', 'Local transport send failed.'));
        else resolve();
      });
    });
  }

  recv(): Promise<TransportFrame | null> {
    if (this.error) return Promise.reject(this.error);
    const frame = this.inbox.shift();
    if (frame) {
      this.buffered -= frameSize(frame);
      return Promise.resolve(frame);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async close(): Promise<void> {
    if (this.closed || this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 1000);
      timer.unref();
      this.socket.once('close', () => { clearTimeout(timer); resolve(); });
      this.socket.close(1000);
    });
  }

  private deliver(frame: TransportFrame): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(frame);
    else {
      this.buffered += frameSize(frame);
      if (this.inbox.length >= 1024 || this.buffered > 8 * 1024 * 1024) {
        this.fail(new TransportError('io', 'Local Agent Host receive capacity exceeded; reconnect required.'));
        this.socket.terminate();
      } else this.inbox.push(frame);
    }
  }

  private fail(error: TransportError): void {
    this.error = error;
    this.inbox.length = 0;
    this.buffered = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function rawBytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

function frameSize(frame: TransportFrame): number {
  return frame.kind === 'text' ? Buffer.byteLength(frame.text)
    : frame.kind === 'binary' ? frame.data.byteLength : Buffer.byteLength(JSON.stringify(frame.message));
}
