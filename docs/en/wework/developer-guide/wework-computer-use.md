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
  -> Electron Node Helper child process (Node IPC)
  -> @trycua/cua-driver
  -> platform accessibility and screen-capture APIs
```

The Electron main process owns the CUA Driver lifecycle. Once computer use is
enabled and system permissions are ready, `ComputerUseService` creates the
Driver in a separate Electron Node Helper process. The main process listens on a
random `127.0.0.1` port and atomically writes its own PID,
address, random token, and start time to
`runtime/computer-use-bridge.json` under the active Executor Home. Disabling
the feature or quitting the application must cancel the current action, close
the bridge, stop the Driver, and remove this file.

Native tools must execute outside the Electron main process. On macOS,
same-process accessibility calls can enter AppKit directly, but CUA's background
threads cannot manipulate AppKit windows. A child process routes window calls
through the host's main thread and isolates native crashes. The child runs the
bundled Helper with `ELECTRON_RUN_AS_NODE=1`, preserving the host's TCC
responsibility chain. Wework still owns permission requests. Node IPC forwards
cancellation to the corresponding native call; losing the host IPC channel
terminates the child immediately.

The bridge uses Node's `child_process.fork` and `send` with error callbacks.
Electron 43.0.0 has a native main-process crash in `utilityProcess.postMessage`
after child termination, so that API cannot carry this crash-isolation boundary.
See [Electron #53293](https://releases.electronjs.org/pr/53293).

An unexpected Driver exit removes the bridge and reports an error while retaining
the enabled preference. Status checks neither restart the Driver nor replay an
action with an unknown outcome. Turning computer use off and on creates a new
process.

Executor reads this runtime record when it launches a Codex conversation. It
does not inject `wework_computer` when the file is absent or invalid, or when
the feature is not ready. For a valid record, Executor starts its own
`computer-use-mcp-server` subcommand as a stdio MCP server and calls Electron
only through token-authenticated local HTTP requests. Mutating tools use
`default_tools_approval_mode = "writes"`; screen reads and tool discovery do
not inherit write approval.

Only one desktop action may run at a time. When the user clicks Stop or presses
Escape, Electron requests cancellation through an `AbortSignal`.
Hiding the activity indicator while leaving the underlying action running is
not sufficient.

MCP continues reading input while tools run, including `notifications/cancelled`
and ping. Cancellation or stdio EOF drops the corresponding HTTP request;
Electron requests SDK cancellation when the response connection closes prematurely.
Tool execution and discovery have a 90-second host deadline, below the HTTP
client's 120-second deadline. Cancelling a dispatched tool call reports its
original reason and `action outcome is unknown`; it does not prove the action
was never executed. Pre-dispatch cancellation and discovery retain their original
reason. Late results cannot replace cancellation errors.

The worker derives read-only classification from the SDK catalog's `readOnlyHint`,
without a handwritten tool registry. Read-only calls and discovery cancel their
SDK Future directly. Mutating calls retain that Future: CUA 0.22.1 can otherwise
leave native input running and skip release cleanup. Action admission remains
occupied until the native call actually finishes or its process exits. Driver
shutdown also waits for process exit before a replacement can be created.
Discovery and tool calls share cancellation handling. If the worker has not
replied within five seconds of cancellation, the host forcibly terminates it
and reports an unknown action outcome. Recovery follows the existing worker
failure flow: the user disables and re-enables computer use, without automatic
action replay. Re-enabling only rebuilds the runtime; forced process termination
does not prove that OS mouse-button or modifier-key state has been released.

The main-process `[computer-use]` log records an operation ID, host and native
worker PIDs, tool name, start, completion, cancellation, failure, and elapsed
time without arguments, screenshots, session content, or tokens. Check these
stages before sampling that operation's `nativePid`. An aggregate call's display
name does not identify the blocked operation. CUA 0.22.1 bounds AX traversal at
20 seconds, but cancelling a Rust
Future cannot forcibly stop already running `spawn_blocking` native work.
Successful SDK cancellation alone therefore does not prove native-thread exit.

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
the Desktop Runtime, Electron creates a `ComputerUseService` instance. Once
the current surface and its required data are usable, the Renderer starts
the window handoff through `renderer.startupReady`. After the splash presents
100%, fades out, and closes, and the main window receives focus, Electron
schedules one background preference restore to read the enablement preference
and initialize the Driver. CUA native module loading and macOS permission
checks run in this background flow.

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
