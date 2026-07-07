---
sidebar_position: 27
---

# Wework macOS Release

English | [简体中文](../../zh/developer-guide/wework-macos-release.md)

The Wework macOS app uses the Tauri updater for automatic upgrades. The release flow is handled by `wework/scripts/release-mac-app.sh`, which calculates the release version, builds the Tauri app, signs updater artifacts, handles the DMG, and uploads the release.

## Release Model

- The default build target is `universal-apple-darwin`, producing one installer that supports both Apple Silicon and Intel Macs.
- The updater manifest includes both `darwin-aarch64` and `darwin-x86_64`; both platform entries can point to the same universal archive.
- `src-tauri/tauri.conf.json` does not store the update service URL or updater public key. The release script injects them through a temporary Tauri config at build time.
- Updater private keys and publish tokens are read only from environment variables or local files and must not be committed.
- Codex CLI is not compiled locally. Before building, `wework/scripts/prepare-codex-binary.mjs` downloads the npm tarball pinned by `wework/codex-binaries.lock.json`, verifies its SHA256, and bundles it as a Tauri resource.

## Bundled Codex Binary

The Wework desktop package includes Codex CLI directly, so users do not need to install it on first launch. The version and per-platform tarball checksums are pinned in `wework/codex-binaries.lock.json`.

Local builds prepare the Codex binary for the current target automatically:

```bash
pnpm --filter wework run prepare:codex
```

macOS universal builds prepare both Apple Silicon and Intel binaries:

```bash
cd wework
WEWORK_CODEX_TARGET=universal-apple-darwin pnpm run prepare:codex
```

Release builds verify the target Codex binary in `wework/src-tauri/build.rs`; the build fails if it is missing. At runtime, Wework injects the bundled Codex path into the local executor sidecar:

- `CODEX_BINARY_PATH`
- `CODEX_MANAGED_PACKAGE_ROOT`

If the user explicitly sets `CODEX_BINARY_PATH` or `CODEX_BIN`, Wework does not override that configuration.

## Environment Variables

Set these variables in the current shell before publishing:

```bash
export WEWORK_UPDATE_BASE_URL=https://example.com/wework/update
export WEWORK_UPDATE_PUBLISH_TOKEN=...
export TAURI_UPDATER_PUBKEY=...
```

The updater private key can be provided directly through `TAURI_SIGNING_PRIVATE_KEY`, or through the default local file path `~/.tauri/wework-updater.key`:

```bash
export TAURI_SIGNING_PRIVATE_KEY=...
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
```

Production releases also require Developer ID signing and Apple notarization:

```bash
export MACOS_APP_SIGN_IDENTITY="Developer ID Application: Example (TEAMID)"
export MACOS_NOTARY_PROFILE=wework-notary
```

Alternatively, provide an Apple ID, Team ID, and app-specific password so the script can create the notary profile:

```bash
export APPLE_BUILD_ID=...
export APPLE_BUILD_TEAM_ID=...
export APPLE_BUILD_PASSWORD=...
```

## Local Verification

Local verification writes a local updater directory. The default local update URL is `http://127.0.0.1:8787/dist/wework`:

```bash
cd wework
scripts/release-mac-app.sh --target local --version 0.1.99 --notes "Local verification."
```

To validate local updater behavior, serve the script output directory:

```bash
python3 -m http.server 8787 --directory src-tauri/target/release/local-update-server
```

## GitHub Release Auto Update

The repository includes `.github/workflows/wework-app.yml` for producing macOS DMGs, Tauri updater archives, signature files, and `latest.json` on GitHub Actions. The updater endpoint embedded in the client points to the GitHub Release latest asset:

```text
https://github.com/<owner>/<repo>/releases/latest/download/latest.json
```

The workflow creates or updates a `wework-v<version>` draft release. After both architecture builds finish, it generates `latest.json`, uploads it to the same release, and then publishes that release as GitHub latest. The client reads this manifest during automatic startup checks and when the titlebar update action is used.

Configure these repository secrets in GitHub Actions:

- `TAURI_SIGNING_PRIVATE_KEY`: Tauri updater private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: private key password; leave empty if the key has no password.
- `TAURI_UPDATER_PUBKEY`: updater public key matching the private key. It is injected into the built app.

Do not rotate the updater private key unless it is acceptable for already-installed clients to stop receiving automatic updates. Tauri verifies new releases with the public key embedded in the installed client.

The workflow uploads these release assets:

- `WeWork_<version>_macos_arm64_unsigned-adhoc.dmg`
- `WeWork_<version>_macos_x64_unsigned-adhoc.dmg`
- `WeWork_<version>_macos_arm64.app.tar.gz`
- `WeWork_<version>_macos_arm64.app.tar.gz.sig`
- `WeWork_<version>_macos_x64.app.tar.gz`
- `WeWork_<version>_macos_x64.app.tar.gz.sig`
- `latest.json`

When downloaded from GitHub Release assets, the link points directly to the `.dmg` file and is not wrapped by an Actions artifact `.zip`. When the workflow is triggered manually without a version input, the release tag auto-increments the patch version from the latest `wework-vX.Y.Z` tag.

## CI DMG Without Apple Developer

The GitHub workflow applies an ad-hoc codesign signature to the `.app`, but it does not perform Apple notarization, so first launch still triggers Gatekeeper. Use this mode for internal testing and developer distribution only; do not label it as a notarized production package.

To force-open the app on first launch. On macOS 15 and later, the warning can still include a **Move to Trash** button; as long as CI passed `codesign --verify --deep --strict`, this is usually the normal Gatekeeper block for a non-notarized app, not a damaged package:

1. Open the DMG and drag `WeWork.app` to `/Applications`.
2. If the first launch shows an unidentified developer or **Move to Trash** warning, click Done. Do not click Move to Trash.
3. Open **System Settings > Privacy & Security**, then click **Open Anyway** in the Security section.

If macOS still keeps the quarantine flag, run this after confirming the source is trusted:

```bash
xattr -dr com.apple.quarantine /Applications/WeWork.app
```

## Production Release

Production release mode reads the remote `latest.json` and automatically increments the patch version. Use `--version` to override it:

```bash
cd wework
scripts/release-mac-app.sh --target prod --notes "Release notes."
```

The script uploads the `.app.tar.gz`, signature file, and DMG. The download entry should point to the latest universal DMG, while updater clients read `latest.json` to resolve the archive URL and signature for their platform.
