# Wework

Wework is the Wegent desktop workbench for local-first AI coding and workplace workflows. It is built with Tauri v2, Vite, React, and TypeScript.

## Capabilities

- Run local Codex-backed tasks through a managed executor sidecar.
- Work with local projects, runtime conversations, attachments, terminals, file previews, and code change review without Backend login.
- Connect to a Wegent Backend when cloud models, cloud devices, remote runtime work, or encrypted Codex auth sync are needed.
- Package macOS builds as DMG releases with bundled Codex binaries and Tauri updater metadata.
- Build iOS simulator, device, and App Store Connect packages from the same Tauri app.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter wework dev
```

For the macOS Tauri app:

```bash
pnpm --filter wework dev:mac
```

Useful checks:

```bash
pnpm --filter wework typecheck
pnpm --filter wework lint
pnpm --filter wework test
pnpm --filter wework e2e
```

## macOS Build and Release

Build a local macOS app bundle or DMG:

```bash
pnpm --filter wework build:mac
pnpm --filter wework build:mac -- --target universal-apple-darwin --bundles app,dmg
```

Release builds prepare the pinned Codex binary before Tauri packaging:

```bash
pnpm --filter wework run prepare:codex
```

The release script handles version calculation, Tauri config injection, updater signing, DMG generation, and upload:

```bash
cd wework
scripts/release-mac-app.sh --target local --version 0.1.99 --notes "Local verification."
scripts/release-mac-app.sh --target prod --notes "Release notes."
```

Production publishing requires updater, signing, and notarization environment variables. See [Wework macOS Release](../docs/en/developer-guide/wework-macos-release.md) for the full release model.

## iOS App

The Tauri app also targets iOS.

### Prerequisites

- Xcode + Command Line Tools
- Rust iOS targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`
- CocoaPods (`brew install cocoapods`) and `xcodegen` (`brew install xcodegen`)

### One-Time Setup

The Xcode project lives in `src-tauri/gen/apple` and is git-ignored because it is regenerable and may embed an Apple Team ID.

```bash
pnpm --filter wework run ios:init
```

### Environment Configuration

iOS native builds have no Vite dev proxy, so backend URLs must be absolute. Each environment is a file under `scripts/ios-env/<env>.env` (`dev`, `staging`, `prod`):

```dotenv
VITE_API_BASE_URL=https://wework.example.com/api
VITE_SOCKET_BASE_URL=https://wework.example.com
APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX
```

### Run and Package

```bash
pnpm --filter wework dev:ios
pnpm --filter wework dev:ios -- --env staging
pnpm --filter wework dev:ios -- --device "iPhone 16 Pro"

pnpm --filter wework build:ios -- --env prod
pnpm --filter wework build:ios -- --env staging --target sim
pnpm --filter wework build:ios -- --env prod --export-method app-store-connect
```

Useful flags: `--target device|sim|x86_64`, `--export-method app-store-connect|release-testing|debugging`, `--build-number N`, `--open`, `--archive-only`, `--no-sign`.

Set `WEWORK_DRY_RUN=1` to print the resolved Tauri command without running it.

Free or personal Apple teams can only create development profiles. Use `--export-method debugging`; the `release-testing` default requires Ad Hoc provisioning permissions. The signed device must also be registered to the team in Xcode.

### Install to a Device

Building does not install the app. List devices, then install the IPA:

```bash
xcrun devicectl list devices
xcrun devicectl device install app --device <UDID> \
  src-tauri/gen/apple/build/arm64/WeWork.ipa
```

On first launch, trust the developer certificate in iOS Settings. The phone must be able to reach the backend URL configured in the selected environment file.

## Related Documentation

- [Local-First Cloud Connection](../docs/en/developer-guide/wework-cloud-connection.md)
- [Runtime Local Work](../docs/en/developer-guide/runtime-local-work.md)
- [Wework macOS Release](../docs/en/developer-guide/wework-macos-release.md)
- [Wework Performance Diagnostics](../docs/en/developer-guide/wework-performance-diagnostics.md)
- [Wework E2E Automation](../docs/en/developer-guide/wework-e2e-automation.md)
