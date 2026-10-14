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
`0.2.0-rc.2`, with `0.1.0-rc.8` retained for existing app requirements.
Each version declares `wework.runtimeRoles` in its manifest and shares one
dependency lockfile across role-specific assets. Roles participate in asset
fingerprints to keep archives and materialized directories distinct.
Each dynamic smart-app tab launches an isolated DSH
process. Every `runtimes/<version>` directory owns an exact manifest and
lockfile.

The Core asset is marked `role: core` and bundles
`@wegent/dsh-app-wework`, `@wegent/dsh-electron-host`, and
`@wegent/dsh-executor-runtime`. It must pass the complete real Executor,
local/cloud transport, Host pipe, and Renderer-service verification gate.

The Workbench asset is marked `role: workbench` and does not contain those
three core plugins. It is verified only for installation, startup, page
reachability, View embedding, tab-scoped shutdown, and credential isolation;
it does not repeat the Core Executor integration gate.

Run:

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
