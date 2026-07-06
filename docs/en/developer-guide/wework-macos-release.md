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

## CI Builds Without Apple Developer

The repository includes `.github/workflows/wework-app.yml` for producing macOS artifacts on GitHub Actions. This workflow does not require an Apple Developer account and builds:

- `wework-macos-arm64-unsigned-adhoc`
- `wework-macos-x64-unsigned-adhoc`

Each artifact contains `.app.zip`, `.dmg`, and `README-macos-unsigned.txt`. The workflow applies an ad-hoc signature to the `.app`:

```bash
codesign --force --deep --options runtime --sign - WeWork.app
```

This build is not Apple notarized, so first launch still triggers Gatekeeper. Users can force-open it from **Open Anyway** in macOS Privacy & Security settings. If the download keeps the quarantine flag, they can also run:

```bash
xattr -dr com.apple.quarantine /Applications/WeWork.app
```

Use this mode for internal testing and developer distribution only. Do not label it as a notarized production package. Public distribution for ordinary users should still use a Developer ID Application certificate and Apple notarization.

## Production Release

Production release mode reads the remote `latest.json` and automatically increments the patch version. Use `--version` to override it:

```bash
cd wework
scripts/release-mac-app.sh --target prod --notes "Release notes."
```

The script uploads the `.app.tar.gz`, signature file, and DMG. The download entry should point to the latest universal DMG, while updater clients read `latest.json` to resolve the archive URL and signature for their platform.
