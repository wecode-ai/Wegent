# Wework

Wework is the Wegent desktop workbench for local-first AI coding and workplace
workflows. It is built with Electron, Vite, React, and TypeScript.

## Capabilities

- Run local Codex-backed tasks through a managed Executor sidecar.
- Work with local projects, conversations, attachments, terminals, file
  previews, and code review without Backend login.
- Connect to a Wegent Backend for cloud models, cloud devices, remote runtime
  work, project spaces, and encrypted Codex authentication sync.
- Package macOS, Windows, and Linux applications with Executor, Codex, DWS,
  plugins, and runtime resources.

## Startup Experience

Wework 启动时只显示一个独立的原生准备窗口，以“人和机器人共同准备工作台”为核心语义，依次呈现整理项目、连接工具和唤醒智能体三个阶段。主窗口在此期间保持隐藏；只有当前路由所需的项目、任务和会话恢复完成，或登录页、运行时错误页已经可以操作时，Renderer 才通过 `renderer.startupReady` 请求 Electron 原子切换到实际工作台。启动超过 10 秒时继续保留同一个动画，并提示仍在加载项目和会话，不得提前显示空白 Shell 或第二套加载状态。启动动效必须保持文案与阶段图形同步，支持深色模式和减少动态效果偏好。Core DSH 最多等待 120 秒完成启动；超时或其他桌面运行时启动失败时必须退出准备动画，显示具体错误和重试入口。

Wework startup uses one independent native preparation window representing a
person and a robot preparing the workbench together. It progresses through
project organization, tool connection, and agent activation while the main
window remains hidden. The Renderer invokes `renderer.startupReady` only after
the projects, task, and conversation required by the active route are restored,
or when a login or runtime-error surface is actionable; Electron then switches
atomically to the real workbench. After 10 seconds, the same animation explains
that projects and conversations are still loading instead of revealing a blank
Shell or a second loading state. Keep the copy synchronized with the visual
stage and support dark mode and reduced motion. Core DSH has up to 120 seconds
to become ready. If it times out or another desktop runtime fails to start,
replace the preparation animation with the concrete error and a retry action.

## Development

Requires Node.js 20+ and pnpm.

From the repository root:

```bash
pnpm install
pnpm --filter wework dev:desktop
```

Useful checks:

```bash
pnpm --filter wework typecheck
pnpm --filter wework lint
pnpm --filter wework test
pnpm --filter wework e2e
```

## Desktop Build

Prepare the bundled resources and build the Electron application for the
current platform:

```bash
pnpm --filter wework build:release
```

GitHub releases are built by `.github/workflows/wework-app.yml`.

## Related Documentation

- [Local-First Cloud Connection](../docs/en/developer-guide/wework-cloud-connection.md)
- [Runtime Local Work](../docs/en/wegent/developer-guide/runtime-local-work.md)
- [Priority Task Filtering](../docs/en/wegent/user-guide/coding/priority-activity-filter.md)
- [Wework Performance Diagnostics](../docs/en/developer-guide/wework-performance-diagnostics.md)
- [Wework E2E Automation](../docs/en/developer-guide/wework-e2e-automation.md)
