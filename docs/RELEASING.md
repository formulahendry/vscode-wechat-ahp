# Releasing WeChat AHP

| Setting | Value |
|---|---|
| Publisher | `formulahendry` |
| Extension | `formulahendry.wechat-ahp` |
| Repository | `formulahendry/vscode-wechat-ahp` |
| Current version | `0.1.1` |
| Package | Universal desktop VSIX for Windows, macOS, and Linux |

Do not bump versions, commit, tag, push, or publish without the maintainer's
explicit request.

## One-time setup

1. Make the repository and its `main` branch public, including the README,
   changelog, license, and reviewed images under `media`.
2. Confirm permission to publish `wechat-ahp` under the `formulahendry` publisher
   in Visual Studio Marketplace and the `formulahendry` namespace in Open VSX.
3. Add the following **Repository secrets** under **Settings > Secrets and
   variables > Actions**. Never put token values in source or chat.

| Secret | Credential |
|---|---|
| `VSCE_PAT` | Azure DevOps PAT with Marketplace management scope and access to the publisher |
| `OVSX_PAT` | Open VSX access token with permission to publish in the namespace |

No GitHub Environment or environment approval is required by this workflow.

The Marketplace icon and README images are PNG. The Activity Bar icon is SVG.
Only cropped/redacted screenshot derivatives belong in the repository. The
original captures can contain account/session identifiers, model settings,
phone status, and unrelated conversation.

## CI

`ci.yml` runs type checks, tests, and normal `vsce` packaging on Windows, macOS,
and Ubuntu for pull requests and pushes to `main`. Each platform uploads a
candidate VSIX as an Actions artifact. CI has no publishing credential.

## Publish

`publish.yml` follows the same two-job structure as
[Agent Skills](https://github.com/formulahendry/vscode-agent-skills/blob/main/.github/workflows/publish.yml):

1. **test** runs on all three operating systems.
2. **publish** waits for all of them, builds `extension.vsix` on Ubuntu, and
   uses `HaaLeo/publish-vscode-extension` to publish that same file first to
   Visual Studio Marketplace and then to Open VSX.

Both jobs check out the workflow event's exact commit. Actions are pinned,
and each publishing action receives only its corresponding Repository secret.
Standard esbuild and bundled-license generation remain; there are no custom
publication, archive-validation, or checksum-transfer scripts.

Start this workflow by publishing a non-prerelease GitHub release or by choosing
**Run workflow**. **A manual Publish run is a publication request, not a
build-only preview.** Use the CI workflow if you only want a candidate package.
Publication proceeds automatically after the three-platform test job succeeds.

For GitHub releases, the tag must equal `v` plus `package.json.version`, currently
`v0.1.1`. GitHub prereleases do not automatically publish to either registry. The
Marketplace `preview` flag is independent of GitHub prerelease status.

The workflow does not create tags, commits, version bumps, or overwrite GitHub
release assets. The two registry uploads are not atomic: if the second fails,
the first may already be published. Inspect both registries before retrying;
an existing version is not silently skipped or overwritten.

## Local package

Stop development watchers, then run:

```text
npm ci
npm run typecheck
npm test
npm run package
```

`vsce` names the output `<name>-<version>.vsix` using `package.json`; no explicit
output filename is needed. Packaging uses the existing `vsce` tool and its
built-in validation; no publishing credential is needed.

Change the version only when the maintainer explicitly requests it. Once a
version has been published, Marketplace will not accept a different package
under the same version.

## Before publishing

Confirm the public README images load, the hosted three-platform jobs pass,
and the selected real Host/Weixin account works in an authorized smoke test.
Local fixtures do not establish native macOS/Linux or service-wide compatibility.

The earlier development ID was `local-wechat-ahp.wechat-ahp`. Stop and disable
that instance before installing the release. The new publisher has a separate
SecretStorage scope, so sign in and bind again; credentials are not read from
another extension's private storage.
