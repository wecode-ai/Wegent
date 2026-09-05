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

Formal macOS and Windows releases must include the `.blockmap` matching each ZIP
and NSIS installer. `electron-updater` compares the previous cached package with
the old and new blockmaps and downloads only changed blocks. It falls back to
the full installer only for a first update, a cleared cache, or a differential
download failure. The release workflow must fail when any required blockmap is
missing. Differential plans, transferred sizes, and fallback reasons are
written to `app-update.log` in the application log directory.

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

## Initial package and component updates

The initial Electron installer contains a complete runtime that can start
offline:

- Electron, whose embedded Node runtime is shared by the Electron main
  process, Core DSH, plugin subprocesses, and Codex skill scripts;
- Core DSH;
- Wework core DSH plugins;
- Wework application static assets;
- bundled personal plugins and Skills;
- Executor;
- Codex;
- DWS.

`components.json` records the application version, release channel, and each
component's version, resource path, and content SHA-256. The Electron
application itself continues to update through `electron-updater`; the other
seven components use independent
`components-<channel>-<platform>-<arch>.json` manifests.

Component archives are named by their archive SHA-256 and stored as immutable
assets. Repository-built Wework core plugin/UI, application static asset,
bundled plugin, and Executor archives live in their corresponding version
Release. External Core DSH, Codex, and DWS archives live centrally in
`wework-updater` for reuse across versions. Version Releases must not attach
Core DSH, Codex, or DWS binaries. Every publication Release contains complete
installers and its component manifests, and uploads only archive hashes that
are not already available at the appropriate location.

The version boundary follows whether an artifact must remain atomically
compatible with the Electron host:

- Application-versioned artifacts: Electron, Chromium, embedded Node, the main
  process, preload, startup shell, Host capability implementations, native Node
  modules, application identity, signing permissions, icons, installers,
  updater protocols, and incompatible local-data migrations.
- Independently versioned components: Core DSH, Wework core DSH plugins and UI,
  Wework application static assets, bundled personal plugins and Skills,
  Executor, Codex, and DWS.
- User-installed marketplace plugins remain independently managed by the
  plugin system and are not part of desktop component publication.

Independent components must still exactly match the current Electron
`appVersion` and switch as one atomic component set. A component change that
requires a new Host capability, native module, or incompatible data format
automatically becomes a full application release.

The Wework UI, core plugins, application static assets, bundled personal
plugins, and Executor share one `wework-<sourceSha12>` runtime version, where
`sourceSha12` is the first 12 hexadecimal characters of the source commit, and
switch atomically through the same component manifest. They remain separate
content-addressed archives only as a transport optimization, so clients
download the files that actually changed; the split does not make Executor an
independently released product. Codex and DWS retain their own product
versions.

The Wework application is further split by change frequency:
`weworkCorePlugins` contains frequently changing application code and UI,
while `weworkAppStatic` contains stable `web/vendor` and `web/wasm` assets. The
client atomically composes both components into the complete plugin directory
before startup. A routine Wework UI change should publish and download only
`weworkCorePlugins`, whose archive must remain below 20 MiB. If it exceeds that
limit, re-examine component ownership instead of adding external binaries such
as Codex, Core DSH, or DWS to the version Release.

The release workflow automatically compares the source commit recorded by the
previous component manifest. If only managed components changed, the Electron
application version stays unchanged and installed clients receive only new
component manifests. Changes to the Electron main process, preload, packaged
resources, or release boundary advance the application version and the full
Electron update manifests. Wework changes that cannot be classified safely
default to a full update.

Every publication creates an immutable Release containing complete installers
with the newest components. Full updates use a `wework-v<appVersion>` tag;
component updates use `wework-v<appVersion>-runtime.<sourceSha12>`, where
`sourceSha12` is the first 12 hexadecimal characters of the source commit,
without advancing the Electron `appVersion`. The newest stable publication is
marked as the GitHub `latest` Release. New users download a complete installer
from that Release, while every historical Release also remains independently
installable.

Repository-built Wework core plugin/UI, application static asset, bundled
plugin, and Executor archives are uploaded to their corresponding version
Release. External Core DSH, Codex, DWS, and other non-repository binary
dependencies use content-addressed archives stored centrally in
`wework-updater` for reuse across versions. Rolling component manifests are
also published there, but it is no longer the first-time installer download
entry point. Existing users therefore download only components that actually
changed and do not redownload Electron and Chromium for a component-only
change.

Online Electron host updates use a separate `WeWorkHostUpdate` artifact. The
rolling Electron manifest points at a slim host package without the seven
managed components only after the currently published version advertises
`componentizedHostUpdate: 1`. The client stages the complete component set for
the target application version before installing that host update. Older
clients without this capability first receive one migration host package that
still contains the managed components, preventing missing runtime resources
after the upgrade. Component manifests and archives must be published before
the Electron YAML so a visible host update never references unavailable
components. Complete installers always contain every component for first-time
offline installation.

The client accepts only a component manifest that exactly matches the running
Electron application version, channel, platform, and architecture. A
manifest's `downloadUrl` may point to a version Release, a shared dependency
Release, or independent object storage; it does not need to share the rolling
manifest's origin or path. Content integrity defines the download trust
boundary: the client verifies the archive size and SHA-256 before extraction,
then verifies the extracted component content SHA-256. Downloads enter a
content-addressed store under the user data directory as `pending` and the
complete component set switches through one atomic state file on the next
startup. Wework confirms the new set only after the workbench and Core DSH
start successfully. A failed startup, or a process exit before confirmation,
rolls back to the previous set on the next launch. Packaged resources remain
the final fallback.

Wework no longer packages or downloads a second Node runtime. At startup it
creates a lightweight `node` entry under the user data directory, prepends it
to `PATH`, points `WEWORK_NODE_PATH`, `NODE`, and `npm_node_execpath` at
Electron, and sets `ELECTRON_RUN_AS_NODE=1`. Core DSH and Codex skills therefore
use Electron's version-bound Node for both explicit `node script.ts` commands
and `#!/usr/bin/env node` entry points.

The entry point also preloads a standard-stream guard. After the consumer of a
stdio MCP or another Node child process closes, diagnostic writes to a broken
`stderr` must not surface as an Electron main-process error dialog. A broken
protocol `stdout` means the caller has gone away, so the child exits normally.
The guard handles only `EPIPE`; other stream errors still fail and expose their
root cause. A configured external Node executable keeps native Node error
handling and does not load this Electron-specific guard.

The Electron main process may also be launched through pipes by a terminal,
development script, or automation runner and remain resident after that parent
exits. Before loading other Electron modules, the main process must install the
same strict `EPIPE` guard on its own `stdout` and `stderr`, preventing later
Node warnings or diagnostic logs from becoming uncaught-exception dialogs
after the consumer closes. This path must neither exit the main process nor
ignore errors other than `EPIPE`; the desktop window and local runtime do not
share the log consumer's lifecycle.

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

The current pin is Codex `0.152.1`. Codex `0.152` disables
`tools.update_plan.enabled` by default, while Wework consumes the corresponding
plan events to render plan blocks, so the Executor must enable the tool
explicitly when launching Codex. Desktop E2E verifies the lockfile binary by
default; only the dedicated `WEWORK_E2E_CODEX_BIN` may override it. It must not
inherit the generic `CODEX_BIN`, which could otherwise select an older binary
from an installed application instead of the repository version under test.

Desktop distributions must also include the project and bundled-sidecar
licenses and attribution notices:

- `LICENSE` at the application resource root contains Wegent's Apache-2.0
  license;
- `licenses/` contains third-party licenses for Electron dependencies such as
  CUA Driver;
- `codex/legal/` contains the Codex Apache-2.0 license, `NOTICE`, and the
  Ratatui MIT license.

`prepare-codex-binary.mjs` generates the Codex legal directory, and
`prepare-package-assets.mjs` must copy it together with the target architecture
binary. Packaging changes must inspect the real packaged application and
confirm that these files exist and match their repository sources. Inspecting
only an intermediate resource directory does not prove that the distribution
is complete.

## Development hot reload

`pnpm --dir wework run dev:mac` continuously builds the original Wework
application through `wework/scripts/dev-wework-app-watch.mjs`. The watcher
clears `dsh/app-wework/web` once at startup and must not clear it again for
incremental builds. A running renderer may still request hashed assets from the
previous generation, and deleting them while the next generation is being
written can leave the window blank.

Each build publishes `.wework-build-id` only after Vite finishes the bundle,
the build result is closed, and file-viewer metadata is normalized. Core DSH
uses this marker as the published build ID, so the page reloads only after the
marker changes instead of treating an intermediate `index.html` write as a
loadable generation.

Automatic reload is enabled only in desktop renderers that expose the Wework
Electron preload capabilities. Opening the Core DSH URL directly in the system
default browser must not start the hot-reload poller. When a desktop renderer
observes a newly published build, it records that build ID before attempting a
reload. If the new page fails to load and the old document remains alive, the
same build must not trigger another reload. A later build with a new ID still
reloads normally.

In development hot-reload mode, static resources under `/wework/app/` must use
`Cache-Control: no-store`. In addition to hashed assets, this tree contains
fixed-name `plugins/*.js` bundles. Serving those files with the production
immutable cache can mix an old plugin bundle with a new main bundle after
reload, creating duplicate instances of modules such as React contexts.
Formal builds continue to use `public, max-age=31536000, immutable`.

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
pnpm --filter wework ai:verify start --packaged true
```

Give each concurrent worktree a distinct `WEWORK_PORT`. Isolated sessions use
separate Executor Homes, application-data directories, and single-instance
locks.

## GitHub Actions

`.github/workflows/wework-app.yml` supports stable and beta channels, an
optional version override, parallel builds for three platforms, Actions
artifacts, formal GitHub Releases, and rolling manifests for both Electron and
legacy Tauri clients. The workflow automatically selects a component or full
publication from the source changes since the last published state; there is
no manual release-kind input. Stable releases advance both stable and beta
channels; beta releases advance only beta. The workflow installs the
dependencies owned by `wework/electron`, prepares bundled sidecars, and calls
the unified Electron build command. Desktop resource changes belong in
`wework/resources/` or the Electron packaging scripts, not in a duplicated
workflow resource list.

A rolling channel may skip an equal-version upload only when both Electron YAML
manifests, all three legacy Tauri JSON manifests, and component manifests for
all four build targets exist. The workflow repairs an incomplete equal version
and fails for an incomplete newer version instead of overwriting it with an
older release. Component archives are never overwritten and are uploaded only
when their content-addressed asset name is absent.
