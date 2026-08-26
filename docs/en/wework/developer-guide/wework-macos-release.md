---
sidebar_position: 26
---

# Wework desktop releases

The Wework desktop application uses Electron. Formal builds and releases are
handled by `.github/workflows/wework-app.yml`, which produces Electron
installers for macOS, Windows, and Linux.

## Version and artifacts

The release version is written to `wework/package.json` and
`wework/electron/package.json`. For a formal release, the workflow commits both
files and builds every platform from that commit. This keeps the About page,
Electron package, and release tag on the same version.

Build release installers with:

```bash
pnpm --dir wework/electron build:release
```

Artifacts are written under `wework/electron/release-installer/`:

```text
WeWork_<version>_macos_<arch>.dmg
WeWork_<version>_macos_<arch>.zip
WeWork_<version>_windows_x64-setup.exe
WeWork_<version>_linux_x64.AppImage
```

## Automatic updates and the Tauri migration

Electron releases use `electron-updater` and the `latest*.yml` or `beta*.yml`
files in the rolling `wework-updater` Release. Before installing a downloaded
update, Wework shuts down its local runtime and then restarts into the new
version. A channel that has not published an Electron release may omit its YAML
manifest; the client treats that state as no available update rather than a
network failure. Other update-check failures remain visible.

The same release also emits signed manifests and artifacts for the legacy Tauri
updater so installed Tauri builds can migrate through the existing Update UI:

- On macOS, the signed Electron `WeWork.app` is additionally packed as an
  `.app.tar.gz`. The Tauri updater replaces the bundle in place while the
  bundle identifier and executable name remain unchanged.
- On Windows, the Tauri updater downloads the Electron NSIS installer. The
  installer accepts Tauri's passive `/P` argument and inherits the legacy
  `Software\you\WeWork` registry entry and `%LOCALAPPDATA%\WeWork` installation
  directory. It removes the old installation, writes Electron to the same path,
  and the legacy relaunch starts Electron.
- Electron directly reuses the legacy Executor Home at `~/.wework`; it does not
  copy or migrate executor data. Local projects, tasks, sessions, and the Wework
  Codex Home continue to load from that directory. The application identifier
  `io.wecode.wework` and product name `WeWork` stay unchanged.
- Linux continues to use manual AppImage replacement.

Formal releases require the platform signing credentials plus
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The Tauri
key signs only the bridge artifacts consumed by legacy clients. Subsequent
Electron updates use the SHA-512 values in the YAML manifests.

## Bundled sidecars and resources

Prepare Codex and DWS before packaging:

```bash
cd wework
pnpm run prepare:codex --materialize
pnpm run prepare:dws
```

The Codex package is pinned by `wework/codex-binaries.lock.json` and verified
with SHA-512. Prepared desktop resources live under `wework/resources/`.
`wework/electron/scripts/prepare-package-assets.mjs` copies sidecars, plugins,
icons, and runtime descriptors into the application resources. Do not maintain
a second desktop resource tree or manifest.

## Local verification

Release changes must run at least:

```bash
pnpm --filter wework typecheck
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test
pnpm --dir wework/electron build:release
```

Changes to windows, tray behavior, IPC, the built-in browser, sidecars, or
packaged resources must also be verified in an isolated real Electron session:

```bash
pnpm --filter wework ai:verify start
```

Give each concurrent worktree a distinct `WEWORK_PORT`. Isolated sessions use
separate Executor Homes, application-data directories, and single-instance
locks.

## GitHub Actions

`.github/workflows/wework-app.yml` supports stable and beta channels, an
optional version override, parallel builds for three platforms, Actions
artifacts, formal GitHub Releases, and rolling manifests for both Electron and
legacy Tauri clients. Stable releases advance both stable and beta channels;
beta releases advance only beta. The workflow installs the dependencies owned
by `wework/electron`, prepares bundled sidecars, and calls the unified Electron
build command. Desktop resource changes belong in `wework/resources/` or the
Electron packaging scripts, not in a duplicated workflow resource list.

A rolling channel may skip an equal-version upload only when both Electron YAML
manifests and all three legacy Tauri JSON manifests exist. The workflow repairs
an incomplete equal version and fails for an incomplete newer version instead
of overwriting it with an older release.
