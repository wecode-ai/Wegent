# Wework showcase plugins

These three independently installable plugins model the most durable categories
across VS Code, JetBrains, and Eclipse:

- `workspace-copilot-demo`: AI assistance grounded in the active repository.
- `quality-guardian-demo`: a Test Explorer with discovery, selection, runs, and output.
- `runtime-doctor-demo`: a Dev Environments status control and setup wizard.

Each plugin has a Node backend registered through `weworkPluginRuntime` and a
browser UI that calls it through `ctx.wework.backend`. They intentionally
exercise three different interaction models: Composer popover, hierarchical
right sidebar, and toolbar-triggered modal workflow. Install one from
**插件 → 管理 → Wework 插件**:

```text
file:/absolute/path/to/showcase-plugins/<plugin-directory>
```

Restart the Wework plugin runtime after installation, enablement, disablement,
updates, or uninstall operations.
