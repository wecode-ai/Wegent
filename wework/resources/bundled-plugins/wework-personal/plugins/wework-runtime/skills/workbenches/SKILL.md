---
name: workbenches
description: 'Create, install, open and manage Wework workbenches based on DSH, including lightweight calculators, TODO notes, extended plugin applications, independent windows, local data and approved system capabilities.'
---

# Wework workbenches

All workbenches use Wework's existing DSH package, installation and runtime system.
`flavor: lightweight` selects a minimal sandboxed page; `flavor: extended` permits
DSH service and plugin composition. Flavor does not determine presentation or
whether a model is required. Both support independent windows and main-window tabs.
The Host owns runtime lifetime, shortcuts, local data and approved native access.

## Task-bound CLI

Use the absolute `WEWORK_CLI_PATH` supplied by Wework for every command. Login
profiles can resolve bare `wework` to another installation. Do not use PATH lookup,
rewrite personal launchers, read registry tokens or call private Host endpoints.
If the binding is missing or cannot execute, report “Task-bound Wework CLI
unavailable” and stop; do not claim workbenches are unsupported.

For an existing DSH project, install using this POSIX command:

```sh
set -eu
if [ -z "${WEWORK_CLI_PATH:-}" ] || [ ! -x "$WEWORK_CLI_PATH" ]; then
  printf '%s\n' 'Task-bound Wework CLI unavailable (WEWORK_CLI_PATH).' >&2
  exit 1
fi
"$WEWORK_CLI_PATH" workbench install --project "/absolute/app-directory" --format json
```

Windows PowerShell uses `& $env:WEWORK_CLI_PATH workbench ...`; cmd.exe uses
`"%WEWORK_CLI_PATH%" workbench ...`. Check that the binding exists, preserve path
boundaries and stop on a nonzero exit. Multiple instances still require selecting
the intended one with `--instance ID`; `"$WEWORK_CLI_PATH" desktop instances`
lists available instances without exposing their authentication tokens.

## Create, verify, install and open

1. Infer the smallest supported flavor from the requested outcome. A calculator
   or TODO note normally uses lightweight. Services, plugins and complex
   workflows use extended. Follow the user's explicit choice. Ask a structured
   question through `request_user_input_async` or `request_user_input` only when a
   missing business requirement materially changes the result; do not add a
   mandatory format questionnaire to an otherwise clear request.
2. Reuse the existing source directory for edits. To create new source, use
   `"$WEWORK_CLI_PATH" workbench create --project "/absolute/app-directory" --name my-tool --display-name "My tool" --flavor lightweight --format json`.
   This scaffolds a pinned DSH project without installing or granting permissions.
   For a standard TODO use `"$WEWORK_CLI_PATH" workbench create-todo --format json`;
   it shows native confirmation and returns the installed identity.
3. For lightweight projects, edit `view.html` and its local page assets. Keep
   `plugin-manifest.json`, `smart-app.verify.json` and the generated DSH bundle.
   Add only required `capabilities.native` entries. Do not edit generated Host or
   Client bridges, add a Node Host module, weaken the iframe sandbox or CSP, or
   introduce remote scripts. For extended projects, read the bundled
   `smart-app-builder` skill and follow its DSH development contract.
4. After editing lightweight page assets, run `node scripts/build.mjs` from the
   project directory to regenerate the trusted bundle. Then verify custom source through
   `"$WEWORK_CLI_PATH" smart-app verify --project "/absolute/app-directory" --format json`.
   Fix the exact structured errors; never substitute manifest-only checks or
   silently widen runtime requirements. Keep business tests with the project. This isolated verification checks package,
   build and DSH page readiness; it does not grant native SDK access or prove
   native business actions. Check those after real installation confirmation.
5. Install with the command above. Wework shows native confirmation naming the
   application and requested capabilities. User format choices and manifest
   declarations do not authorize system access. Do not bypass the confirmation,
   write installation files or retry a declined installation. CLI `null` means
   installation was cancelled; stop before launch.
6. Read the successful result's top-level `id` (the Host installation identity),
   then run `"$WEWORK_CLI_PATH" workbench launch --id INSTALLATION_ID --format json`.
   Do not use manifest names, market IDs, temporary URLs or UI tab IDs as this ID.
   Claim launch success only when the real command succeeds.
7. Report the workbench name and reopening path **Applications → Workbenches →
   Mine**. Create desktop shortcuts or global keys only when requested. Keep
   source for future edits; install updates through the same confirmation and
   preserve the existing installation identity and data.

## Lightweight SDK and capability contract

The isolated page receives `window.weworkWorkbench`. Methods are asynchronous;
await them and show failures. The Host binds every call to the authenticated
installation; the page cannot supply another installation ID or arbitrary paths.

The SDK belongs to the initial document. Leaving or replacing it revokes its
connection; replacement documents receive no SDK or automatic reauthorization.
Network navigation and redirects remain natively blocked, but local replacements
such as `about:blank` may commit. Open external links with
`await window.weworkWorkbench.external.open(url)` using declared and granted
`external.open`, rather than navigating the app page. To recover, open
**Applications → Workbenches → Mine → More actions → Stop**, wait for **Run**,
then click **Run** to create a new page while retaining saved local data.
Closing or hiding may retain the existing instance and does not guarantee recovery.

The page uses `sandbox="allow-scripts"` without `allow-forms`, with CSP
`form-action 'none'`. Native form submission can be blocked before a `submit`
callback runs. Do not depend on `form.onsubmit`, a `submit` event,
`requestSubmit()` or `form.submit()` for business actions. Use an explicit
`<button type="button">` click handler and an Enter key handler on text inputs
that calls the same action after `preventDefault()`. Ignore IME events with
`isComposing: true`, await SDK calls and show failures. Verify real button clicks
and Enter input; manually dispatching `submit` bypasses the browser restriction
and does not prove the interaction works. Keep the sandbox and CSP unchanged.

| API                                                   | Required capability                  | Result                                        |
| ----------------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| `storage.get()`                                       | None                                 | App-owned JSON document, initially `null`     |
| `storage.set(value)`                                  | None                                 | Replace this installation's JSON, up to 1 MiB |
| `notifications.show({ title, body })`                 | `notifications`                      | System notification                           |
| `clipboard.readText()` / `clipboard.writeText(text)`  | `clipboard.read` / `clipboard.write` | Clipboard text                                |
| `files.openText()` / `files.saveText({ name, text })` | `files.read` / `files.write`         | Native chooser; cancelled open returns `null` |
| `external.open(url)`                                  | `external.open`                      | Approved HTTP(S) or `mailto:` link            |
| `window.hide()` / `window.setAlwaysOnTop(boolean)`    | None                                 | Control the current presentation              |

Storage is one JSON document, not a key-value store. Initialize from
`await window.weworkWorkbench.storage.get()` and save with
`await window.weworkWorkbench.storage.set(value)`. Await successful saves before
updating the interface and show failures. Saving app state does not require a
notification grant. `notifications.show` sends an immediate system notification;
it requires the declared and granted capability plus operating-system support.

## Lifecycle and presentation

```text
"$WEWORK_CLI_PATH" workbench list --format json
"$WEWORK_CLI_PATH" workbench launch --id INSTALLATION_ID --presentation window
"$WEWORK_CLI_PATH" workbench launch --id INSTALLATION_ID --presentation tab
"$WEWORK_CLI_PATH" workbench configure --id INSTALLATION_ID --presentation window --resident true --background true
"$WEWORK_CLI_PATH" workbench hide --id INSTALLATION_ID
"$WEWORK_CLI_PATH" workbench stop --id INSTALLATION_ID
"$WEWORK_CLI_PATH" workbench shortcut --id INSTALLATION_ID
"$WEWORK_CLI_PATH" workbench set-shortcut --id INSTALLATION_ID --accelerator CommandOrControl+Shift+T
"$WEWORK_CLI_PATH" workbench set-shortcut --id INSTALLATION_ID --clear true
"$WEWORK_CLI_PATH" workbench remove --id INSTALLATION_ID
```

Repeated opens focus the same installation. Presentation changes reuse its DSH
runtime. Closing its last view follows its background preference (`--background true|false`);
`--resident` separately controls automatic startup. Stop preserves
local data; uninstall removes owned state.
Desktop shortcuts can cold-start the Host directly into a workbench. Global
shortcuts require Wework to remain running. Do not uninstall or delete data
outside the user's explicit request.
