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

生产构建将首屏静态依赖的 Lucide 图标合并为一个共享模块，减少本地 HTTP
加载的独立请求。动态贡献使用的其他图标仍按需加载；可选查看器保持原有动态导入边界。

Production builds combine statically imported Lucide icons into one shared module
to reduce separate local HTTP requests. Other icons used by dynamic contributions
remain demand-loaded, and optional viewers retain their dynamic import boundaries.

任务描述编辑器在首次打开编辑区域时加载，避免首屏预加载 BlockNote 及其依赖。
加载期间保留当前描述和回调，创建与编辑任务继续使用同一套编辑器。

The task description editor loads when its editing area first opens, keeping
BlockNote and its dependencies out of the initial page load. Pending loading
retains the current description and callbacks; task creation and editing use
the same editor.

内置插件组合目录引用不可变组件源，避免在写入 Core profile 前重复复制代码。
原生准备窗口加载与运行时准备并行执行，两者都完成后才载入工作台。
工作模式检测与组件准备、两个独立的桌面桥接服务分别并行初始化。
正常启动直接加载 Core 页面；旧错误页面仅在准备窗口无法显示错误时加载。
Core 进程使用 `--port 0` 直接绑定系统分配的端口，通过已认证的宿主管道传回实际地址，
再完成认证并校验全部必需接口，避免预选端口在进程启动前被其他进程占用。
管道中的会话地址不写入日志，也不等待非首屏插件完成全部启动。
Core 崩溃自动重启后，工作台在必需接口重新就绪时切换到新地址，更新安全来源并
恢复固定窗口；Executor 保持运行，旧 Smart app 的运行时选择和缓存保持有效。
创建或升级 Core profile 时直接写入当前工作模式的插件组合，避免随后启动额外的
DSH 校验进程来重复调整同一组插件；运行时启动仍校验实际生效的配置。
Core profile 使用有界并发准备内置插件，代码保留独立副本以继续从 profile 解析依赖，
静态网页资源使用目录链接。所有插件准备完成后才写入版本标记；任何复制失败都会阻止启动。

The bundled plugin composition references immutable component sources, avoiding
a duplicate code copy before profile preparation. Native startup windows load
alongside runtime preparation; the workbench loads only after both complete.
Workbench mode detection and component preparation run concurrently, as do the
two independent desktop bridges. Normal startup loads the Core page directly;
the error page loads only if the preparation window cannot display the error.
Core binds an OS-assigned port with `--port 0`. The host discovers its actual
address through the authenticated host pipe before authentication and required
endpoint checks, eliminating the gap between selecting a port and binding it.
The session URL stays out of logs, and readiness does not wait for optional plugins.
After an automatic Core restart, the workbench reloads the ready endpoint, updates
its allowed origin, and restores fixed windows. The Executor keeps running, and
existing Smart app runtime requirements and caches remain valid.
Profile creation and upgrades write the selected workbench mode directly,
avoiding a separate DSH validation process to adjust the same plugins afterwards.
Runtime startup still validates the effective configuration. Core profile preparation uses
bounded concurrency for bundled plugins. Plugin code
remains an independent copy so dependencies resolve from the profile; static web
resources use directory links. The version stamp is written only after every plugin
has finished, and any copy failure prevents startup.

本地任务数据库在单个事务中完成初始化与迁移，减少首次启动的磁盘同步次数。
执行活动修复使用同一事务；失败会回滚全部迁移，已是当前结构的数据库继续直接读取。

Local task database initialization and migration run in one transaction, reducing
disk synchronization during first startup. Execution activity repair shares that
transaction; failures roll back the entire migration, while current schemas
retain their direct read path.

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

## Composer Submission State

发送包含附件的消息时，输入文本与本次提交的附件必须作为同一个快照立即从输入框清除，
不得等待任务创建或模型响应完成。异步发送期间新添加的附件属于下一次提交，不得被上一
次发送的延迟清理移除；如果任务创建失败，文本、附件和错误提示必须一起恢复到用户当前
可见的原始会话。

When a message includes attachments, the composer must clear the submitted text
and attachment snapshot together without waiting for task creation or the model
response. Attachments added while that send is pending belong to the next
submission and must not be removed by delayed cleanup from the previous send. If
task creation fails, restore the text, attachments, and error to the original
conversation that remains visible to the user.

## Embedded Browser Navigation

内嵌浏览器首次加载实际页面时会移除初始化用的 `about:blank` 历史项，
避免后退到空白宿主页；后续页面的前进、后退记录正常保留。

The embedded browser removes its bootstrap `about:blank` history entry when the
first real page commits. Later navigation retains normal Back and Forward history.

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

Wework 构建会将当前源码提交写入 Renderer。GitHub release 优先使用
`WEWORK_SOURCE_SHA`，其他 CI 使用 `GITHUB_SHA`，本地构建使用 Git `HEAD`。
“设置 > 关于”显示 12 位短提交 ID，并通过标题属性保留完整提交 ID，方便定位安装包
对应的源码。

Prepare the bundled resources and build the Electron application for the
current platform:

```bash
pnpm --filter wework build:release
```

GitHub releases are built by `.github/workflows/wework-app.yml`.
Each build embeds its source commit in the Renderer. GitHub releases prefer
`WEWORK_SOURCE_SHA`, other CI builds use `GITHUB_SHA`, and local builds use Git
`HEAD`. Settings > About shows the 12-character commit ID and retains the full
commit ID in its title attribute so an installed package can be traced back to
its source.

## Related Documentation

- [Local-First Cloud Connection](../docs/en/developer-guide/wework-cloud-connection.md)
- [Runtime Local Work](../docs/en/wegent/developer-guide/runtime-local-work.md)
- [Priority Task Filtering](../docs/en/wegent/user-guide/coding/priority-activity-filter.md)
- [Wework Performance Diagnostics](../docs/en/developer-guide/wework-performance-diagnostics.md)
- [Wework E2E Automation](../docs/en/developer-guide/wework-e2e-automation.md)
