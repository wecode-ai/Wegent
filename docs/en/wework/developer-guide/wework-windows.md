---
sidebar_position: 27
---

# Wework Windows development and builds

The Wework Windows desktop application uses Electron and shares the same
renderer, Electron main process, and Executor sidecar protocol as macOS and
Linux.

## Prerequisites

Install Node.js, pnpm, Git, and the Rust toolchain required to build the
Executor. Then install dependencies:

```powershell
pnpm install --frozen-lockfile
pnpm --dir wework/electron install --frozen-lockfile
```

## Development

```powershell
pnpm --filter wework dev:windows
```

This command is driven by `wework/scripts/dev-windows-app.ps1` (the Windows
counterpart of `dev-mac-app.sh`): it prepares Electron resources (icons and
bundled plugins), Codex/DWS binaries, the Node runtime, and the Harness runtime
(including the core DSH), builds the Executor, and then starts the
`wework/electron` main process to load the Wework renderer. Electron exchanges
JSONL with the Executor sidecar through child process stdin/stdout, without a
Unix domain socket or fixed TCP port.

Runtime and Executor build caches default to `%LOCALAPPDATA%\wegent\` (override
with `WEWORK_DEV_CACHE_ROOT` or `WEGENT_CARGO_TARGET_ROOT`); the first
preparation is slow and later runs are incremental. Pass
`-- --executor-isolation` to use a temporary Executor Home, or set
`WEWORK_DRY_RUN=1` to print only the resolved launch configuration. If a
download stalls, set the `HTTP_PROXY`/`HTTPS_PROXY` environment variables first.

## Build

```powershell
pnpm --dir wework/electron build:release
```

The NSIS installer is written to
`wework/electron/release-installer/WeWork_<version>_windows_x64-setup.exe`.
Icons, plugins, runtime descriptors, and sidecars come from
`wework/resources/` and are copied into the application by
`wework/electron/scripts/prepare-package-assets.mjs`.

The installer also migrates legacy Tauri installations to Electron. It accepts
the `/P` argument passed by the Tauri updater, reads the legacy
`Software\you\WeWork` registry entry, and keeps the
`%LOCALAPPDATA%\WeWork` installation directory. After the Update action
installs Electron, the legacy client relaunches the same `WeWork.exe` path.
This avoids a second installation directory and preserves user data.
The Executor started by Electron continues to use the existing `.wework`
directory under the user's home directly; no directory copy or data migration
is performed.

## Verification

```powershell
pnpm --filter wework typecheck
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test
pnpm --dir wework/electron build:release
```

`.github/workflows/wework-app.yml` creates the signed installer, Electron YAML
update manifest, and legacy Tauri JSON/signature bridge on `windows-latest`.

## Troubleshooting

- **Electron cannot find the Executor**: make sure sidecar preparation
  completed before packaging and inspect `resources/bin/` in the package.
- **The renderer cannot connect to the main process**: verify that preload was
  built and that `wework/electron/dist/` and the renderer came from the same
  build.
- **A path or command fails on Windows**: use Node path APIs and argument
  arrays; do not compose POSIX shell commands or hard-code `/`.
