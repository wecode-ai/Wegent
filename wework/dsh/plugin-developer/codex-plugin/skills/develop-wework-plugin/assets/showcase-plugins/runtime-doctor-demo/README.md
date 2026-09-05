# Dev Environments

A development-environment showcase inspired by Dev Containers, Remote
Development, and Docker tooling. A compact workspace-toolbar status control
opens a three-step global setup wizard.

The backend detects real project and tool signals, recommends a container image,
and creates `.devcontainer/devcontainer.json` only after the user presses the
wizard's explicit generation action.

Public contracts demonstrated:

- `weworkPluginRuntime`
- `ctx.wework.backend`
- `ctx.wework.environments.providers`
- `wework.workspace.toolbar.action`
- `wework.shell.overlay`

The plugin verifies actual Node.js, Python, Git, and Docker executables and
preserves an existing Dev Container configuration.
