# Third-party notices

This is an independent community preview, not an official Tencent, Microsoft or
GitHub product. WeChat/Weixin and VS Code names belong to their respective owners.

## Bundled dependencies

The build gathers the licenses of every npm package actually included in the
runtime bundle into `dist/THIRD_PARTY_LICENSES.txt`, which is shipped in the VSIX.
Development tooling and tests are not shipped.

Direct runtime dependencies:

| Package | Pinned version | License |
|---|---|---|
| @microsoft/agent-host-protocol | 0.9.0 | MIT |
| ws | 8.21.3 | MIT |
| qrcode | 1.5.4 | MIT |
| lossless-json | 4.3.1 | MIT |
| zod | 4.3.6 | MIT |

The SDK npm archive does not include its upstream LICENSE file. Its license is
preserved in `licenses/agent-host-protocol.txt` and included in the generated
license collection. Source: https://github.com/microsoft/agent-host-protocol/blob/main/LICENSE,
retrieved 2026-09-18.

## ahp-channels

https://github.com/TylerLeonhardt/ahp-channels

`src/transport.ts` adapts the local socket WebSocket transport and HTTP Agent
technique from `src/socketWebSocketTransport.ts`. Host discovery, AHP initialization,
queued-message behavior and client tool lifecycle also follow the public
`endpoints.ts`, `ahp.ts`, `bridge.ts`, `channelPermissions.ts` and `toolInput.ts`
contracts inspected on 2026-09-18. The ahp-channels extension, CLI, MCP channel
runtime and plugins are NOT dependencies and are not installed or launched.
The current implementation uses AHP's published visible Markdown/turn-completion events for
explicitly consented bidirectional text sync; it no longer contributes a reply tool.

MIT License

Copyright (c) 2026 Tyler Leonhardt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Weixin protocol and internal transport handoff

The HTTP/auth/input-filtering implementation was ported and adapted from the
separately implemented `wechat-ahp-channel` PoC's frozen source handoff on
2026-09-18. There is no runtime import, file-state sharing, build dependency or
MCP dependency on that project. The plaintext CLI store was NOT copied.

Frozen source SHA-256 provenance:

| Source | SHA-256 |
|---|---|
| src/common.ts | FCCA1EEC9CB12CF61A3D927EBF6AE27552E7C63A8268679988D585262EC74933 |
| src/api.ts | 2C585BB1E5BF3A8726EC6D983B41AACDD01F9254EE50A4ECF9C5762CF79ADAF0 |
| src/login.ts | 3F48B260080816A834C062C3A15943064A208A91A7FAEB0DA0D2279DB5E5A4F3 |
| src/state.ts | 343B0469E9357256518E488D62727E1BBA4DEC54FB5AB555F0B37CA31E3BC551 |
| src/channel.ts | B4226B61F716B77D478AF53DF426A7488DA9D1D4D627E9C6092EB3EDC334FF2B |

The PoC adapter was independently written using the following Tencent protocol
references, not copied from or executed through OpenClaw:

- https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
- https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts
- https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts

Tencent's project is MIT-licensed, Copyright (C) 2026 Tencent. Its protocol
documentation describes observed client behavior, not a complete server contract.
No claims of unrestricted account access, guaranteed service availability or
server-side message time limits are made by this extension.

The current `sendmessage` acknowledgement handling follows the upstream
`sendMessage` function and protocol reference inspected on 2026-09-18:
a successful HTTP response with a JSON object may omit `ret`; explicit nonzero
`ret` or `errcode` still fails. This indicates API acceptance, not a read receipt.
Existing uncertain send records are not reclassified as successful or replayed.
