# Changelog

## [0.1.2] - 2026-09-20

### Added

- Best-effort WeChat typing indicators while the bound agent is working, with
  cancellation when it pauses, finishes, or disconnects.
- A fixed English notice asking the owner to return to VS Code when confirmation
  or input is required. Notices are deduplicated per waiting episode and cannot
  approve tools or expose their details.
- Usage telemetry distinguishing WeChat and editor-side user inputs, completed
  agent turns, and logical message-delivery outcomes. This expands collection
  beyond 0.1.1 basic telemetry without collecting content, account/resource IDs,
  hashes, message lengths, or delivery/generation durations.
- Private journal v3 migration preserving credentials, cursors, deduplication and
  uncertain deliveries; status notices appear separately in Recent Deliveries.

## [0.1.1] - 2026-09-19

### Added

- Basic usage and reliability telemetry through the official VS Code telemetry
  SDK in all extension modes, including F5/development and tests, respecting the
  global telemetry level, live changes, and host-enforced logging-only mode.
- Command-ID events, sign-in/connection outcomes and durations, and allowlisted
  error categories. No chat content, account/binding identifiers, per-message
  metrics, or raw errors are collected.
- A packaged telemetry declaration and privacy documentation disclosing the
  SDK's standard pseudonymous machine/session identifiers.

## [0.1.0] - 2026-09-18

Initial preview release for native local desktop VS Code on Windows, macOS, and Linux.

### Added

- Two-way text synchronization with an explicitly selected existing local
  Agent Host chat.
- QR sign-in with a single authenticated WeChat owner and SecretStorage-backed
  credentials and delivery state.
- Native **Sessions** and **Connection** views for discovery, binding, scoped
  AHP actions, channel health, and recent delivery metadata.
- `[VS Code User]` source labels and Unicode-safe segmentation for messages
  typed in VS Code.
- Automatic forwarding of completed visible agent text, without requiring a
  model-owned reply tool.
- Workspace-trust and working-directory checks, a cross-window owner lock,
  bounded reconnect behavior, durable queues, and explicit uncertain-delivery
  handling.
- Redacted diagnostics and recovery actions that do not automatically resend
  uncertain messages or cancel another client's agent turn.
- Platform-aware Stable/Insiders discovery, Unix-domain socket support,
  kernel-held per-user ownership locks, and universal packaging.

### Limitations

- Universal desktop package; native local Windows, macOS, and Linux workspaces only.
- Direct text, one owner, and one bound chat. No remote hosts, groups, media,
  history backfill, or always-on background service.

[0.1.2]: https://github.com/formulahendry/vscode-wechat-ahp/releases/tag/v0.1.2
[0.1.1]: https://github.com/formulahendry/vscode-wechat-ahp/releases/tag/v0.1.1
[0.1.0]: https://github.com/formulahendry/vscode-wechat-ahp/releases/tag/v0.1.0
