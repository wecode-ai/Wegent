---
sidebar_position: 26
---

# Wework macOS releases

The Wework desktop application uses Electron. Formal builds and releases are
handled by `.github/workflows/wework-app.yml`, which produces Electron
application archives for macOS, Windows, and Linux.

## Version and artifacts

The release version is written to `wework/package.json` and
`wework/electron/package.json`. For a formal release, the workflow commits both
files and builds every platform from that commit. This keeps the About page,
Electron package, and release tag on the same version.

Build the application with:

```bash
pnpm --filter wework ai:verify:electron:build
```

The macOS package is written to:

```text
wework/electron/release/WeWork-darwin-<arch>/WeWork.app
```

The workflow archives the platform directory as
`WeWork_<version>_macos.tar.gz` and uploads it to the GitHub Release for formal
publishes.

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
pnpm --filter wework ai:verify:electron:build
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
artifacts, and formal GitHub Releases. The workflow installs the dependencies
owned by `wework/electron`, prepares bundled sidecars, and calls the unified
Electron build command. Desktop resource changes belong in
`wework/resources/` or the Electron packaging scripts, not in a duplicated
workflow resource list.
