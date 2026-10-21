---
sidebar_position: 13
---

# Wework DSH Runtime

Ordinary Core plugin management disables client hot reload and applies changes on
explicit restart. Plugin development enables hot reload separately, so package
installation cannot remount the desktop merely by replacing unchanged client files.

This directory defines the reproducible, multi-version DeepSeek Harness
runtimes used by Wework. It never reads or modifies a user's personal `~/.dsh`
profile.

The bundled Core Runtime is `0.2.0-rc.2`. The default Workbench Runtime is
`0.2.0-rc.2`. Installers include only that default version's archive;
legacy `0.1.0-rc.8` is downloaded when an app requires it.
Each version declares `wework.runtimeRoles` in its manifest and shares one
archive and immutable materialized directory across roles. The catalog retains
one entry per role, pointing to the same asset name, fingerprint, and checksum.
Each dynamic smart-app tab launches an isolated DSH
process. The default `runtimes/<version>` directory owns an exact manifest and
lockfile. Legacy assets are pinned per platform in `published-runtimes.json`
and are never rebuilt using the current machine's signing identity.

The archive's `runtime.json` declares supported `roles`; its published archive
descriptor does not contain a single role. Core loads `@wegent/dsh-app-wework`,
`@wegent/dsh-electron-host`, and `@wegent/dsh-executor-runtime` from the separate
core plugin component. It must pass the complete real Executor,
local/cloud transport, Host pipe, and Renderer-service verification gate.

Workbench does not copy those three core plugins. Sharing archives shares only
immutable dependencies, never user profiles, sessions, credentials, or processes.
Workbench is verified only for installation, startup, page
reachability, View embedding, tab-scoped shutdown, and credential isolation;
it does not repeat the Core Executor integration gate.

The packaged `runtimes.json` lists bundled defaults under `runtimes` and pinned
legacy descriptors under `downloadableRuntimes`, including the exact version,
source fingerprint, archive size, SHA-256, and download URL. Core startup only
materializes the bundled version. App startup, project scripts, and isolated
verification select and prepare only the highest catalog version satisfying
`requirements.dsh`. Requirements outside the catalog fail explicitly.

The default download base is
`https://github.com/wecode-ai/Wegent/releases/download/wework-updater/`, with
asset names `harness-runtime-<platform>-<arch>-dsh-<version>-<fingerprint>.tar.gz`.
Set `WEWORK_HARNESS_RUNTIME_BASE_URL` at build time to override it. Runtime
downloads use the pinned catalog URL rather than a floating latest release.
Builds prepare and publish only the default archive for future reuse. Pinned
legacy assets remain in the existing Release and are not rebuilt, downloaded,
or uploaded during packaging, nor included in installers or the Core DSH component.

Downloads require HTTPS and stream-check size and SHA-256 before publishing
the archive cache and extracting it. Downloads abort after 60 seconds without
progress. Host app startup and verification requests use a 15-minute budget;
ordinary requests retain their existing budget. Archives live under `archives/` in the
runtime cache root; extracted directories are keyed by source fingerprint.
Concurrent requests for one fingerprint share preparation. Materialized runtimes
work offline. Cached archives are verified again before re-extraction, and corrupt
archives are downloaded again. Failures remove temporary files and surface an
error; a later request can attempt preparation again.

```bash
cd wework
pnpm run prepare:harness-runtime
pnpm run prepare:harness-runtime -- --materialize
```

Every generated runtime archive must be self-contained. The preparation script
uses `node_modules/.pnpm` inside the archive staging directory and must not
retain dependency links into the build machine's global pnpm store. Before
archiving, it rejects broken symlinks and links that resolve outside the
runtime root. Changes to the dependency layout or archive semantics must also
bump `archiveFormatVersion` so published assets from the old format cannot be
reused.

The three built-in tabs share one Core DSH process. Each active smart-app tab
owns an isolated Workbench DSH process that must exit when the tab closes.

The new DSH version requires browser authentication. The bundled `wework-browser-auth` plugin passes its authenticated launch URL to Electron through an inherited anonymous pipe (FD 5). Electron establishes the browser session before probing pages. Credentials are excluded from application URLs, installation records, and public HTTP endpoints. Legacy Workbench runtimes retain their existing startup flow.
