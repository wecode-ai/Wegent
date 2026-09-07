# Test Explorer

A testing showcase inspired by VS Code Test Explorer, Eclipse TestNG, Pytest,
and language-specific test adapters. Its right-sidebar tree discovers real test
files, lets the user select targets, starts a bounded test process, and displays
run state and output.

Public contracts demonstrated:

- `weworkPluginRuntime`
- `ctx.wework.backend`
- `ctx.wework.testing.providers`
- `wework.workspace.sidebar.tab`

Discovery is bounded and ignores generated dependency trees; runs are limited
to selected tests with a 30-second process timeout.
