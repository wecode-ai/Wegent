# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## iOS App (Tauri)

The desktop app is built with [Tauri v2](https://v2.tauri.app/), which also targets iOS.

### Prerequisites

- Xcode + Command Line Tools
- Rust iOS targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`
- CocoaPods (`brew install cocoapods`) and `xcodegen` (`brew install xcodegen`)

### One-time setup

The Xcode project lives in `src-tauri/gen/apple` and is **git-ignored** (regenerable, and a real build may embed your Apple Team ID into it). Generate it locally with:

```bash
pnpm run ios:init
```

### Per-environment configuration

iOS native builds have **no Vite dev proxy**, so the backend URLs must be absolute.
Each environment is a file under `scripts/ios-env/<env>.env` (`dev`, `staging`, `prod`).
Edit these to point at your real backend before building:

```dotenv
VITE_API_BASE_URL=https://wework.example.com/api
VITE_SOCKET_BASE_URL=https://wework.example.com
APPLE_DEVELOPMENT_TEAM=XXXXXXXXXX   # Apple Team ID for signing (device/IPA)
```

### Dev (simulator / device)

```bash
pnpm run dev:ios                          # env=dev (default)
pnpm run dev:ios -- --env staging
pnpm run dev:ios -- --device "iPhone 16 Pro"
```

### Build / package

```bash
pnpm run build:ios -- --env prod                         # device IPA (release-testing)
pnpm run build:ios -- --env staging --target sim         # simulator build
pnpm run build:ios -- --env prod --export-method app-store-connect
```

Useful flags: `--target device|sim|x86_64`, `--export-method app-store-connect|release-testing|debugging`,
`--build-number N`, `--open`, `--archive-only`, `--no-sign`.
Set `WEWORK_DRY_RUN=1` to print the resolved `tauri` command without running it.

> **Free / Personal Apple teams** can only create *development* profiles, not Ad Hoc or
> App Store ones. Use `--export-method debugging` (the `release-testing` default fails with
> "does not have permission to create iOS Ad Hoc provisioning profiles"). The signed device
> must also be registered to the team — set this up once in Xcode (open `src-tauri/gen/apple`,
> select the target → Signing & Capabilities → pick the team with Automatic signing).

### Install to a device

Building does not install. List devices, then install the IPA:

```bash
xcrun devicectl list devices                              # find your device UDID
xcrun devicectl device install app --device <UDID> \
  src-tauri/gen/apple/build/arm64/WeWork.ipa
```

First launch: on the phone, **Settings ▸ General ▸ VPN & Device Management** → trust the
developer certificate, otherwise iOS blocks the app as an untrusted developer.

The phone must reach the backend URL from `local.env` (same LAN, backend listening on `0.0.0.0`).
