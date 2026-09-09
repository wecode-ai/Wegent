---
sidebar_position: 8
---

# Develop Core DSH plugins in an isolated Wework instance

The bundled **Wework Plugin Developer** is a Wework plugin. It may carry a
nested Codex plugin in the official Codex format, and Wework uses two complete
Electron processes for Core DSH plugin development:

- The main instance contributes a create action to the Wework plugins page and
  a **Plugin debugging** tab to plugin projects.
- The development instance loads the plugin under development and has an
  independent application identity, user-data directory, account state,
  Executor home, Core DSH home, plugin profile, cache, and logs.

The instances do not copy accounts, cookies, tokens, or local product data. If
the plugin needs cloud data, the developer signs in separately in the
development instance. Exiting the main instance stops the development instance
and its Core DSH, Executor, and plugin child processes.

## Start a development instance

1. Open the bundled **Wework Plugin Developer**. The Wework plugin is the outer
   delivery unit; its nested Codex plugin supplies the development Skill and is
   registered by default with the outer plugin.
2. Open **Plugins → Manage → Wework plugins**, select **Create plugin**, and
   choose an empty directory.
3. Wework writes the minimum preset and registers the directory as a local
   project.
4. Open the project's right workspace and choose **Plugin debugging**.
5. Select **Start debugging instance**. Wework focuses the second instance
   after it becomes ready.

Only one Core DSH plugin development instance runs at a time. When the source
directory changes, Wework stops the old instance before creating a stable but
isolated data directory for the new source.

## HMR and restart boundaries

The development instance adds the source package to its own `wework-core`
profile through `link:`. Wework re-enables the official DeepSeek Harness HMR
row in the final profile layer and limits its watch root to the selected source
directory. Browser changes continue to use the client-HMR supplied by DSH Web.

Normal Node and browser implementation changes should use HMR. Select
**Restart Core DSH** after:

- dependency, export, or DSH metadata changes in `package.json`;
- `cordis.patch.yml` changes that alter plugin composition or service
  dependencies;
- framework-level changes for which HMR requests a host-process restart;
- an unrecoverable plugin error.

Do not treat a file-watcher notification as proof that behavior was updated.
Confirm the actual behavior in the development instance and inspect Core DSH
logs.

Project classification runs once when the workspace changes and is cached by
canonical source root. Wework watches only the marker, package manifest, and
bundle patch. React renders, chat updates, and tab changes do not scan disk.

## Plugin debugging tab

- **Open instance** focuses the running second Wework.
- **Developer tools** opens Electron DevTools for the development instance's
  main WebView.
- **Logs** opens the instance-specific log directory for Electron, Core DSH,
  and server-side plugin startup failures.
- **Stop** ends the development instance but preserves its isolated login and
  local state.
- **Delete isolated data** stops the instance and deletes account state,
  caches, the profile, Executor data, and logs. It does not delete plugin
  source files.

## Control instances with the Wework CLI

Wework adds its general `wework` CLI to the environment of Wework-managed
agents. The CLI controls both the main instance and isolated instances; plugin
development does not have a separate automation entry point. From a plugin
project, `--project .` selects the debugging instance registered for that
project:

```bash
wework desktop instances
wework desktop status --project .
wework desktop inspect --project . --interactive true
wework desktop click --project . --selector '[data-testid="example-action"]'
wework desktop fill --project . --selector '[data-testid="example-input"]' --value 'value'
wework desktop press --project . --selector '[data-testid="example-input"]' --key Enter
wework desktop wait --project . --selector '[data-testid="example-result"]' --text 'ready'
wework desktop screenshot --project . --output test-results/plugin-debug.png
```

Run `inspect` before choosing a target and prefer stable `data-testid`
selectors. Verify each `click`, `fill`, or `press` with `wait` or another
`inspect`. If multiple instances match, run `wework desktop instances` and
select one explicitly with `--instance`.

The CLI exposes structured inspection and user-level interaction, not
arbitrary JavaScript execution. Wework manages instance discovery, loopback
addresses, and authentication, so Skills and plugin source do not contain
machine paths, ports, or tokens.

## Containment model

The Wework plugin is the outer delivery unit. Its own `package.json` may use
`wework.codexPlugin` to declare a nested Codex plugin directory. That nested
directory must remain an official Codex plugin: it may contain
`.codex-plugin/plugin.json`, `skills/`, MCP configuration, and other officially
supported Codex content, but no Wework- or DSH-specific manifest fields.

The outer **Wework Plugin Developer** package lives at
`wework/dsh/plugin-developer`, and its nested Codex plugin lives at
`wework/dsh/plugin-developer/codex-plugin`. Desktop resource preparation
projects bundled plugin assets, rather than `CODEX_HOME`, into the Wework-owned
marketplace at `<resourcesRoot>/bundled-plugins/wework-personal` and registers
the nested plugin by default; the projected directory is not source. Runtime
authentication is prepared separately from the native Codex home: `auth.json`
is copied on Windows and linked on other platforms. The outer Wework plugin
directly registers the create action and debugging tab, so neither UI entry is
gated by Codex plugin installation.

New projects use the same structure:

```text
plugin-root/
├── package.json
├── cordis.patch.yml
├── client.js
└── codex-plugin/
    ├── .codex-plugin/plugin.json
    └── skills/
```
