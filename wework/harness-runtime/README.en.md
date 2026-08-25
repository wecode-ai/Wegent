---
sidebar_position: 13
---

# Wework DSH Runtime

This directory defines the reproducible, multi-version DeepSeek Harness
runtimes used by Wework. It never reads or modifies a user's personal `~/.dsh`
profile.

The bundled Core Runtime is `0.1.1-rc.2`. The first Workbench Runtime is
`0.1.0-rc.8`; each dynamic smart-app tab launches it as an isolated DSH
process. Every `runtimes/<version>` directory owns an exact manifest and
lockfile.

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

The three built-in tabs share one Core DSH process. Each active smart-app tab
owns an isolated Workbench DSH process that must exit when the tab closes.
