# Wework DSH App

`@wegent/dsh-app-wework` is Wework's first-party modular monolith product
plugin.

The current version registers three non-closable fixed tabs in one DSH client
context:

- Tasks
- Project spaces
- Agents

The Smart Workbench and its dynamic tabs are managed by the same plugin. Fixed
tabs, dynamic tabs, the active route, `WorkbenchBinding`, and the Codex thread
write lease are persisted in storage owned by the DSH page. Restoring this
state never replays a task or turn.

Electron hosts one primary DSH `WebContentsView`. Host features such as the
Wework built-in browser, file pickers, native windows, and system menus remain
implemented by Electron and will be reached through restricted desktop
capabilities.

The package must explicitly export `./package.json`. The DSH client module
registry resolves that subpath to read the `dsh.client` declaration; without
the export, the plugin is omitted from the browser boot graph.
