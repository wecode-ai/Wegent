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

## Production Release

Production release mode reads the remote `latest.json` and automatically increments the patch version. Use `--version` to override it:

```bash
cd wework
scripts/release-mac-app.sh --target prod --notes "Release notes."
```

The script uploads the `.app.tar.gz`, signature file, and DMG. The download entry should point to the latest universal DMG, while updater clients read `latest.json` to resolve the archive URL and signature for their platform.
