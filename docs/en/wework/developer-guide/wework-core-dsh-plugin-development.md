---
sidebar_position: 8
---

# Develop Core DSH plugins in an isolated Wework instance

After installing **Wework Plugin Developer** from the official marketplace,
Wework uses two complete Electron processes for Core DSH plugin development:

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

1. Install **Wework Plugin Developer**. The composite package contains both a
   Core DSH UI extension and a Codex Skill.
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

## Composite plugin

The Codex part of **Wework Plugin Developer** lives under
`wework/resources/bundled-plugins/wework-personal/plugins/wework-plugin-developer`.
Its `.codex-plugin/plugin.json` and `skills/` guide Codex when developing Core
DSH UI and Skills. The companion built-in DSH plugin lives under
`wework/dsh/plugin-developer`; it contributes the create action and conditional
debugging tab, and exposes them only after the Codex plugin is installed. The
bundled personal marketplace marks the Codex plugin as available instead of
installed by default.
