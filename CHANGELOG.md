# Changelog

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

[0.1.0]: https://github.com/formulahendry/vscode-wechat-ahp/releases/tag/v0.1.0
