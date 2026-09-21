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

## Project Space Board Progress

项目空间看板中的运行中卡片展示智能体当前输出的过程文本，而不是内部思考文本。标准视图按内容自然增高，最多展示两行过程文本，并在其下展示已移除 Shell 启动包装的真实命令摘要。状态分组下可启用“专注视图”，将进行中与待确认两列从 `292px` 展开到 `480px`，展示最多八行过程文本和最近三条工具活动；入口作为独立的视图操作右对齐展示。该偏好按用户和项目保存，切换到其他分组时隐藏，返回状态分组后恢复。

Running cards on project-space boards show the agent's current process output
instead of internal thinking text. The standard view grows naturally with the
content, shows up to three process lines, and displays the actual command
summary without Shell launcher wrappers. In status grouping, **Focus view**
expands the In progress column from `292px` to `480px`, showing up to eight
process lines and the latest three tool activities. The preference is stored
per user and project, hidden for other grouping modes, and restored when the
board returns to status grouping.

## Conversation Processing State

对话中的工具和过程记录只有在最终文字停止流式输出、且当前轮次已经结束后，才会折叠为“已处理”。流式输出期间保持过程区域结构稳定，避免完成态反复显示和隐藏，导致后续文字跳动或闪烁。

Tool and process activity in a conversation collapses into the completed
processing summary only after final text has stopped streaming and the active
turn has settled. While output is streaming, Wework keeps the processing layout
stable so the completed state cannot repeatedly appear and disappear or make
following text flicker.

## Collaboration Loading

协作侧栏的空间与项目摘要是跨页面复用的导航状态。进入 Issue 首页、项目或空间时不得清空或
重新请求已有导航；本地与云端数据源分别完成后合并展示，一个数据源的加载或失败不得移除
另一个数据源的现有条目。页面数据按当前视图加载：成员、智能体、协作组、设备和运行记录
只能在消费它们的页面请求。空间首页可以后台渐进加载各项目的 Issue 摘要，但不得等待所有
项目完成后才显示空间框架。Wework 的本地项目 Issue 操作必须始终路由到本地适配器。

Collaboration workspace and project summaries are reusable navigation state
across pages. Opening the Issue home, a project, or a workspace must not clear
or refetch navigation that is already available. Local and cloud sources merge
as each source completes; loading or failure in one source must not remove
existing entries from the other. Page data is loaded only by the view that
consumes it: members, agents, collaboration groups, devices, and executions
must not be fetched for unrelated pages. A workspace home may progressively
load per-project Issue summaries in the background, but it must render the
workspace shell without waiting for every project. Issue operations for local
Wework projects must always use the local adapter.

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
