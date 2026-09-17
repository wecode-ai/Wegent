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

In development the script builds the renderer output
(`wework/dsh/app-wework/web`), starts a Vite watch build, and serves the
running desktop app from the latest build through
`WEWORK_APP_WEB_ROOT`/`WEWORK_APP_HOT_RELOAD` with automatic reload when the
build changes, matching `dev-mac-app.sh`. Branch switches and renderer edits
therefore take effect without manually syncing packaged plugin artifacts.

The script also mirrors the macOS development instance model: it derives a
stable worktree identity and title, gives Electron an isolated application
identifier and user-data directory, and creates component resources for the
source Core DSH plugins. A renamed executable bundle is macOS-specific; on
Windows, the development title is carried by the Electron process identity.

Immutable Runtime archives and Executor build caches default to
`%LOCALAPPDATA%\wegent\` (override with `WEWORK_DEV_CACHE_ROOT` or
`WEGENT_CARGO_TARGET_ROOT`). When the system drive is low on space and no cache
exists yet, Cargo target selection falls back to `D:` through `H:`. Mutable,
worktree-specific materialized runtimes stay in the checkout's
`wework/node_modules/.cache` so different worktrees cannot share live files.
The first preparation is slow and later runs are incremental. Pass
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

The installer uses Electron Builder's standard NSIS installation flow without
custom passive-install arguments or installation registry migration.

## Verification

```powershell
pnpm --filter wework typecheck
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test
pnpm --dir wework/electron build:release
```

Build the native desktop E2E application through the shared entrypoint:

```powershell
$env:CI = "true"
pnpm --filter wework ai:verify:electron:build
```

This command prepares Electron, Codex, DWS, and the Executor sidecar, then
produces a native application for the current operating system. On Windows the
result is `wework/electron/release/WeWork-win32-x64/WeWork.exe`; a Linux or
macOS package is not an equivalent substitute.

`.github/workflows/wework-e2e.yml` builds this native application on
`windows-latest` and runs Windows Desktop Core E2E with the same Core shard
matrix used by Linux. A complete regression runs all 17 Core shards. When path
classification selects only specific checkpoints, both platforms still run the
same selected shards. Windows path, drive-letter, UNC, named-pipe, and `.exe`
sidecar behavior must be verified by this Windows job and cannot be inferred
from another platform passing.

`.github/workflows/wework-app.yml` creates the signed installer and Electron
YAML update manifest on `windows-latest`.

## Troubleshooting

- **Electron cannot find the Executor**: make sure sidecar preparation
  completed before packaging and inspect `resources/bin/` in the package.
- **The renderer cannot connect to the main process**: verify that preload was
  built and that `wework/electron/dist/` and the renderer came from the same
  build.
- **A path or command fails on Windows**: use Node path APIs and argument
  arrays; do not compose POSIX shell commands or hard-code `/`.
