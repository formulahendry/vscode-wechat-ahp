import { release } from 'node:os';
import { SafeError } from './common.js';

export interface DesktopEnvironment {
  platform?: NodeJS.Platform;
  remoteName?: string;
  env?: NodeJS.ProcessEnv;
  kernelRelease?: string;
}

export function isLocalDesktop({
  platform = process.platform, remoteName, env = process.env, kernelRelease = release(),
}: DesktopEnvironment = {}): boolean {
  if (!['win32', 'darwin', 'linux'].includes(platform) || remoteName) return false;
  return platform !== 'linux' || !(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(kernelRelease));
}

export function assertLocalDesktop(environment: DesktopEnvironment = {}): void {
  if (!isLocalDesktop(environment)) {
    throw new SafeError('Use native local desktop VS Code on Windows, macOS or Linux. Remote-SSH, WSL, dev containers and web are unsupported.');
  }
}
