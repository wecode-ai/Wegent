---
sidebar_position: 39
---

# Computer use

Wework computer use lets local Codex conversations control desktop applications
after the user grants permission. It uses `@trycua/cua-driver` for accessibility
and screen access, while Wework continues to own conversation integration,
permission state, action approval, cancellation, and MCP exposure.

Computer use is only for desktop applications outside the Wework built-in
browser. Web tasks continue to use `wework_browser`; do not emulate browser
actions through desktop control.

## Architecture

The call path is:

```text
Codex
  -> wework_computer MCP
  -> packaged wegent-executor
  -> Bearer-authenticated loopback HTTP bridge
  -> Electron ComputerUseService
  -> @trycua/cua-driver
  -> platform accessibility and screen-capture APIs
```

The Electron main process owns the CUA Driver lifecycle. Once computer use is
enabled and system permissions are ready, `ComputerUseService` creates the
Driver, listens on a random `127.0.0.1` port, and atomically writes the PID,
address, random token, and start time to
`runtime/computer-use-bridge.json` under the active Executor Home. Disabling
the feature or quitting the application must cancel the current action, close
the bridge, stop the Driver, and remove this file.

Executor reads this runtime record when it launches a Codex conversation. It
does not inject `wework_computer` when the file is absent or invalid, or when
the feature is not ready. For a valid record, Executor starts its own
`computer-use-mcp-server` subcommand as a stdio MCP server and calls Electron
only through token-authenticated local HTTP requests. Mutating tools use
`default_tools_approval_mode = "writes"`; screen reads and tool discovery do
not inherit write approval.

Only one desktop action may run at a time. When the user clicks Stop or presses
Escape, Electron cancels the active Driver call through an `AbortSignal`.
Hiding the activity indicator while leaving the underlying action running is
not sufficient.

## Permissions and settings

On macOS, the actual Wework application process requires:

- Accessibility permission;
- Screen and System Audio Recording permission.

For a release build, the permission owner is the signed `WeWork.app`. In source
development it may appear as `Electron`. macOS normally requires restarting
the corresponding application process after a permission change. Windows and
Linux do not show the macOS permission flow, but Driver capability and runtime
errors remain visible.

The master switch is stored in Wework desktop preferences. While configuring
the Desktop Runtime, Electron only creates `ComputerUseService`; it does not
read the enablement preference or load the Driver. Once the main surface is
actionable, the Renderer closes the startup window through
`renderer.startupReady`. Electron then schedules one background preference
restore without waiting for native Driver initialization. CUA native module
loading and macOS permission checks therefore do not block Executor, Core DSH,
or the first actionable workbench.

The background restore reads the latest preference before it starts. It skips
Driver startup when the feature has been disabled or the application is
quitting. If permissions are missing, it preserves the enabled intent without
creating the bridge and the settings page continues to show the missing
permissions. A later status check retries startup after permissions become
available.

## Release integration

CUA is not a separate sidecar and is never installed dynamically from the user
environment or network. The Electron package pins `@trycua/cua-driver`, and
pnpm selects the platform-native package, such as
`@trycua/cua-driver-darwin-arm64`.

JavaScript files enter `app.asar`, while native `.node`, `.dylib`, `.so`, and
`.dll` files are unpacked into `app.asar.unpacked` by the Electron packaging
configuration. Native dynamic loading cannot read an ASAR virtual path, so the
pnpm dependency patch under `wework/electron/patches/` rewrites the CUA
library path from `app.asar` to its matching `app.asar.unpacked` path. A CUA
version upgrade must update the patch declaration, lockfile, and packaging
verification together.

CUA is a native dependency of the Electron host and cannot be hot-updated
through an independent component manifest. Changes to the CUA version, native
libraries, or bridge contract require a full Electron application release and
the normal platform signing flow. The package also installs the CUA MIT
license under `Resources/licenses`.

A macOS ARM64 artifact must contain at least:

```text
WeWork.app/Contents/Resources/
├── app.asar
├── app.asar.unpacked/node_modules/@trycua/cua-driver-darwin-arm64/
│   ├── cua_driver_node_runtime.node
│   └── libcua_driver_sdk.dylib
└── licenses/cua-driver-LICENSE.md
```

## Security boundaries

- The bridge listens only on loopback and requires a random Bearer Token.
- The runtime record and its parent directory are restricted to the current
  user; logs and telemetry must never contain the token.
- Wework owns enablement, write approval, and cancellation semantics. Driver
  defaults are not the product authorization model.
- Screenshots, accessibility trees, and entered text are not persisted by
  default. Test evidence must not contain credentials or user-private data.
- npm, shell commands, or external daemons must not bypass the Wework
  permission and approval path.

## Verification

Focused verification includes:

```bash
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test \
  src/host/computer-use-startup.test.ts \
  src/host/computer-use-service.test.ts
pnpm --filter wework test \
  src/components/settings/ComputerUseSettingsPage.test.tsx \
  src/features/computer-use/ComputerUseActivityIndicator.test.tsx \
  scripts/desktop-resource-migration.test.mjs
cargo test --manifest-path executor/Cargo.toml computer_use --lib
bash .github/scripts/test-classify-ci-changes.sh
```

Changes to packaged resources or native loading must also build a real
installer and pass the desktop E2E `computer-use` checkpoint. Verification
must confirm that native libraries are under `app.asar.unpacked`, the license
is present, settings persist, and the Driver publishes its tool catalog when
permissions are ready. Missing system permission is a visible product state
and must not be silently skipped by E2E.
