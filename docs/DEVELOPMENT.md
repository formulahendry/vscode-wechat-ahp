# Development

## Prerequisites

- Native Windows, macOS, or Linux with Node.js 22.22 or later and npm.
- VS Code 1.110 or later for extension development.
- No real WeChat account or Agent Host is required for automated tests.

```text
npm ci
npm run typecheck
npm test
npm run package
```

The runtime uses the Node extension host; end users do not install Node.js.
Dependencies are locked in `package-lock.json`.

## F5 debugging

Open the project root in VS Code and press **F5** using
**Run WeChat AHP Extension**. The default build task starts TypeScript and esbuild
watchers, then opens an Extension Development Host.

Set breakpoints in `src\extension.ts`, `src\channelController.ts`, or the protocol
modules. Development builds include source maps. Saving a file rebuilds the
bundle; use **Developer: Reload Window** in the development host or
**Ctrl+Shift+F5** in the source window to load it again.

**Shift+F5** stops debugging. Watch tasks can remain running; use
**Tasks: Terminate Task** when finished. Stop watchers before making a release
package so development output cannot overwrite production output.

The esbuild problem matcher is embedded in `.vscode\tasks.json`; no additional
matcher extension is needed.

Telemetry uses the same official SDK in production, F5/development, and test
extension modes, respecting VS Code's effective global telemetry setting. F5
can send events to the configured Application Insights resource. The official
VS Code extension test host forces logging-only mode; this extension does not
bypass it. Repository Node tests use fake reporters or an in-memory SDK fetcher
and do not contact the live telemetry resource.

F5 never authorizes a real channel automatically. Use explicit sign-in, binding,
and connection consent. Disconnect another instance before using the same
account, and do not run the separate MCP PoC against the same bot concurrently.

## Project structure

```text
.vscode\                  Debug launch and build tasks
.github\workflows\        CI and gated Marketplace publishing
src\extension.ts          Activation entrypoint
src\channelController.ts  Shared commands, status, and lifecycle
src\views\                Native Sessions and Connection trees
src\sessionCatalog.ts     Lazy, read-only AHP metadata browsing
src\bridge.ts             Existing-chat subscription and dispatch
src\textSync.ts           Source-correlated text synchronization
src\messagePresentation.ts  English source labels and chunking
src\weixin.ts             Weixin HTTP transport
src\storage.ts            SecretStorage journal and migration
test\                     Node unit/integration and mocked VS Code tests
scripts\                  Build, license, and release checks
media\                    Extension icon and sanitized README screenshot
```

`dist\`, `.test-build\`, `node_modules\`, and `*.vsix` are generated.
The build follows the official VS Code
[extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
and [esbuild guidance](https://code.visualstudio.com/api/working-with-extensions/bundling-extension).

## Build and test boundaries

- `npm run compile`: type-check and make a source-mapped development bundle.
- `npm run watch:tsc` / `npm run watch:esbuild`: individual watchers.
- `npm run build`: production bundle and dependency license collection.
- `npm run build:tests`: test-only entrypoint.
- `npm test`: Node tests with serialized AHP/Weixin fixtures and mocked VS Code.
- `npm run package`: standard `vsce` packaging of the universal VSIX.

The production bundle has only VS Code and Node builtins as external runtime
dependencies. Tests cover TCP and native IPC (Windows named pipe or POSIX Unix-domain socket) AHP transports, original
text, role labels, routing, cancellation, reconnect, privacy boundaries, native
view actions, and SecretStorage failure/recovery.

Discovery and desktop gating have platform-parametrized tests. The native IPC,
cross-process locking, QR fixture, and mocked VS Code command/view tests run on
each CI operating system. POSIX filesystem ownership and symlink checks run on
macOS/Linux; Windows checks use named-pipe semantics. A Windows local test run
does not substitute for the native macOS/Linux jobs.

The macOS/Linux lock is a deterministic `127.0.0.1` TCP lease keyed by the OS UID.
It exchanges no data and has no heartbeat or stale-file cleanup race. An occupied
port is a hard error; never fall back to another port. Tests use isolated user
identities or ephemeral leases so they cannot contend with a real local bot.
The Windows pipe name remains compatible with earlier builds.

Mocked VS Code tests do not establish actual UI appearance or real Weixin
eligibility. Real smoke testing requires explicit user authorization and a
compatible Host/provider. Never reuse another project's credentials or state.

## Protocol and storage notes

The AHP SDK is pinned to `@microsoft/agent-host-protocol@0.9.0`, negotiating
`0.9.0`, `0.8.0`, `0.7.0`, `0.6.0`, `0.5.2`, or `0.5.1`.
Discovery/authentication follow the local VS Code endpoint registry; they are
not defined by AHP itself.

The default data roots are `%APPDATA%` on Windows, `~/Library/Application Support`
on macOS, and `$XDG_CONFIG_HOME` (or `~/.config`) on Linux. Only Stable/Insiders
desktop registries are searched, not `.vscode-server` data. POSIX registry
directories/files must be owned by the current UID and not group/world writable.
Unix socket files must be actual sockets owned by the current user, not symlinks.
Remote extension windows and WSL are rejected before opening the channel.

Use exact Host/session/chat identities, including provider-defined URI schemes.
Do not infer identity from titles. Keep Weixin context tokens internal and
preserve send intent before network I/O. Missing `ret` on successful
`sendmessage` HTTP/JSON responses follows the documented upstream client
behavior; explicit business failures still fail.

The SDK's local subscription iterator must be unsubscribed before closing a
parked iterator during shutdown. Do not cancel another client's turn when
disconnecting the extension.

The journal's schema version is independent of the extension version. Newer
private state may not be readable by an older development build. Journal v3
migrates v1/v2 credentials, cursors, routes and uncertain-send evidence and adds
status notices and local observation guards. Those guards are not a telemetry
outbox: disabled-period events are not buffered or replayed. An older 0.1.1
build may refuse v3 state rather than overwrite it.

## Version and change policy

Change the extension version only when the maintainer explicitly requests it.
Code changes do not automatically bump the version.
Do not create a commit, tag, push, or publish without the maintainer's explicit
authorization. See [Releasing](RELEASING.md) for the Marketplace workflow.
