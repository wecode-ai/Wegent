---
sidebar_position: 13
---

# Wework DSH Runtime

This directory defines the reproducible, multi-version DeepSeek Harness
runtimes used by Wework. It never reads or modifies a user's personal `~/.dsh`
profile.

The bundled Core and default Workbench Runtime are `0.2.0-rc.2`; each dynamic
smart-app tab launches its own isolated DSH process. Existing apps requiring
`0.1.0-rc.8` download that runtime on first launch, verify its size, SHA-256,
and identity, then reuse the cache offline. Each role under `runtimes/` owns
an exact manifest and lockfile. `runtimeRole` distinguishes Core from Workbench;
`runtimeBundled: false` publishes a downloadable asset without adding it to
the Electron package.

Core is extracted during the build and referenced from the immutable component
directory, avoiding dependency extraction on first launch. Downloads use the
catalog's release URL by default; `WEWORK_HARNESS_RUNTIME_BASE_URL` may specify
a mirror root while preserving asset names and all integrity checks.

Built-in plugins link their static web directories to the signed component.
Plugin code stays in the profile to preserve dependency resolution without
copying the web assets again.

Release preparation collects every runtime archive and descriptor directly
from the build cache. Linux E2E artifacts include a separate download-service
asset directory; production installers bundle only the default runtimes.

Browser authentication in `0.2.0-rc.2` uses the official DSH launch-token
exchange. Tokens stay in process memory; renderer URLs, diagnostics, and
runtime catalogs never retain launch tokens.

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

Smart app verification uses a private empty credential file compatible with
both runtime schemas. Verification scripts run only in the app project and
do not trigger dependency installation in a parent workspace. Verification
processes must be cleaned up when the verification exits.
The Remote template uses Typert's `create()` codec factories and verifies a
real `health.ping` round trip. Its HTTP probe receives only the isolated
runtime's session cookie, which is redacted from output logs. Runtime shutdown
and temporary-directory removal wait until the probe has settled.
