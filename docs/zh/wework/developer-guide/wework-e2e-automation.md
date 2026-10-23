---
sidebar_position: 34
---

# E2E 自动化

桌面 E2E 共享 fixture 使用 `GPT 5.6 Luna`。真实运行时目录同时存在 `GPT-5.6 Luna` 和 `GPT 5.6 Luna` 两种显示名称，默认模型选择断言接受这两种名称，同时继续核对模型 ID 和供应商。任务恢复断言继续核对 fixture 原有的显示名称。

桌面检查点清理结果目录时保留 `backend-rs-logs/`，供 CI 上传 Rust 网关启动日志。设置页按当前全局路由显示，同时保留原标签页的应用路由，返回时恢复原应用。

Wework 提供独立的 Playwright E2E 入口和测试专用前端自动化接口，用于在 CI 中稳定操作 Wework 的 Vite/React 前端。默认入口运行在浏览器模式，适合覆盖大多数前端交互；原生窗口与任务执行链路由下文的桌面端全链路 E2E 覆盖。

## 运行方式

首次运行需要安装 Playwright 浏览器：

```bash
pnpm --filter wework exec playwright install chromium
```

运行 Wework E2E：

```bash
pnpm --filter wework e2e
```

运行真实桌面端任务全链路 E2E：

```bash
pnpm --filter wework e2e:desktop
```

仅运行云端项目桌面 E2E：

```bash
pnpm --filter wework e2e:desktop:cloud
```

仅运行插件市场、安装、对话使用和卸载链路：

```bash
pnpm --filter wework e2e:desktop:plugins
```

仅运行内置浏览器 Agent 操作回归：

```bash
pnpm --filter wework e2e:desktop:embedded-browser
```

在 macOS 上运行桌面内存回归，包括流式输出增长和 10 个并发任务的整机内存检查：

```bash
pnpm --filter wework e2e:desktop:memory
```

仅验证助手已有流式文本时，其下方持续显示“正在思考”，并在响应完成后消失：

```bash
pnpm --filter wework e2e:desktop:streaming-text
```

该命令会通过 `wework/playwright.config.ts` 启动测试专用 Vite 服务：

```bash
pnpm exec vite --host 127.0.0.1 --port 4174 --mode e2e
```

同时会启动 Responses API、Sites upstream 和 Connector upstream mock：

```bash
node e2e/utils/mock-response-api-server.mjs
node e2e/utils/mock-sites-upstream-server.mjs
node e2e/utils/mock-connector-upstream-server.mjs
```

配置默认设置：

- `VITE_WEWORK_E2E=true`
- `VITE_WEWORK_RUNTIME_MODE=backend`
- `VITE_LOGIN_MODE=password`
- `WEWORK_RESPONSE_API_MOCK_URL`: `http://127.0.0.1:9998`
- `WEWORK_SITES_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9997`
- `WEWORK_CONNECTOR_UPSTREAM_MOCK_URL`: `http://127.0.0.1:9996`

三个 mock 的端口都可以通过同名 `*_PORT` 环境变量覆盖：`WEWORK_RESPONSE_API_MOCK_PORT`、`WEWORK_SITES_UPSTREAM_MOCK_PORT` 和 `WEWORK_CONNECTOR_UPSTREAM_MOCK_PORT`。如果覆盖端口，也可以直接传入完整 URL 环境变量给测试进程。

测试不 mock 后端 API。没有启动 Backend 时，登录页 smoke 测试只验证前端能渲染登录入口；需要登录后的业务流程时，CI 必须先启动真实 Backend 和依赖服务。

## 桌面端任务全链路 E2E

`wework/e2e/desktop/task-flow.e2e.mjs` 覆盖本机工作区中的真实任务生命周期，并允许产品发行版注入可选桌面场景：

1. 构建并启动真实 Electron Wework 应用，使用 `--open-workspace` 打开隔离工作区。
2. 启动真实 `wegent-executor` sidecar，并由它启动真实 `codex app-server`。
3. 在原生 WebView 中填入任务、点击发送，并等待真实会话渲染完成。
4. 校验 Codex 向模型服务发出的请求、Codex 实际工具调用写入的工作区文件，以及页面中的最终回复。
5. 在同一会话中发送连续追问，并校验对应请求和页面回复。
6. 启动流式回复后通过桌面端 UI 取消，校验任务已停止、停止提示已渲染，并在发送后续消息时恢复输入。
7. 让模型首次请求确定性失败，点击错误卡中的重试，并校验重试请求和最终回复。
8. 创建两轮短对话，切换到新对话后重新打开原对话，校验 2 条用户消息、2 条助手消息和 4 个统一虚拟行仍完整挂载，并确认首条消息靠近消息视口顶部，防止缓存恢复时丢失消息或留下大块顶部空白。
9. 如果设置了 `WEWORK_E2E_DESKTOP_SCENARIO_MODULE`，动态加载产品场景；公共 runner 只提供 HTTP、WebSocket、控制和诊断生命周期，不包含具体产品协议或断言。

测试不模拟 Wework、Executor 或 Codex。为了让回归结果确定且不需要真实 provider 账号，测试只在 loopback 地址启动模型服务，分别实现 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages。每种接口都会执行文本回复以及“发送 → `apply_patch` → 工具结果回传 → 完成回复”，工具调用仍由真实 Codex 在隔离工作区内执行。

回复预测及其图片描述请求独立于前台场景分发。切换到协议矩阵后，上一会话的后台图片描述仍可能到达；模型服务先识别这类请求，沿用图片描述的协议校验和响应，不推进矩阵状态。`desktop-reply-prediction-fixture.test.mjs` 覆盖这条跨场景请求路径，前台模型的端点与模型 ID 断言保持不变。

模型协议矩阵按“执行位置 × 模型来源 × 协议”定义 18 个组合：

- 本机执行覆盖本机自定义模型、Codex 内置模型和云端 Model CRD，每种模型来源分别覆盖三种协议，共 9 个完整文本与工具链路。
- 云端执行同样覆盖本机自定义模型、Codex 内置模型和云端 Model CRD 的三种协议，共 9 个完整文本与工具链路。
- 第一个“本机自定义模型 → 云端设备”组合会验证同步确认框、目标 Executor 模型目录写入和云端 Codex 重启；随后三个本机模型协议都必须完成文本与 `apply_patch` 工具链路。

矩阵提交等待上限为 10 秒。如果编辑器已经显示提交错误，runner 会立即抛出该错误；否则在协议阶段未按时推进时输出当前阶段和已捕获请求，避免失败后长时间无反馈。

`e2e:desktop:streaming-text` 通过场景模块运行独立的流式消息状态回归。它使用真实 Electron renderer、Executor 和 Codex app-server，通过 loopback Responses SSE 保持部分回复处于运行状态。场景先让同一个 assistant item 以 `final_answer` 开始流式输出、再以 `commentary` 完成，验证 Executor 通过 `response.block.created.replacesItemId` 通知前端把已显示正文原子迁移到过程块，页面只保留一份过程文本且最终回答区为空。随后场景验证流式推理显示“正在思考 · 摘要”，并在响应完成后移除推理摘要及其占位，再启动长命令，确认工具行耗时在切换任务后连续递增，同时工具分组标题不显示整轮累计耗时。场景还会构造超过虚拟化阈值的多轮长对话，验证“正在思考”位置、用户滚动锚点、流式增长和任务重开后的视口稳定性。它通过 `scrollFromBottomAsUser` 模拟用户从底部上划固定距离，并使用 `startScrollStabilitySampling` / `getScrollStabilitySample` 在流式分片期间联合记录锚点几何位置、DOM 变化和真实 `scroll` 事件；门禁要求锚点没有往返位移，且用户停住后不再发生程序化滚动事件。响应完成后，场景还会确认等待状态消失。该场景会保存阶段改判、推理、工具计时、就绪、流式和完成阶段的截图；场景专用 Codex 配置会关闭插件扩展，以隔离验证消息直出链路。

`e2e:desktop:embedded-browser` 通过场景模块运行内置浏览器 Agent 操作回归。它使用真实 Electron renderer、Executor、Codex app-server 和 browser MCP server，打开本地 fixture 页面并通过Electron `WebContentsView` bridge 验证浏览器控制链路。场景覆盖 bridge identity 读取、认证 bridge 请求、打开页面、结构化 `inspect`、`fill`、`click`、`wait`、`scroll`、`screenshot`、`capabilities`、高风险动作确认，以及 MCP 组合工具 `open_and_inspect` 和 `wait_and_inspect`。它还会启动一个长时间 `waitFor`，再验证独立 `click` 不会被阻塞，用于防止 bridge 并发退化。新增本地文件能力时，该场景还会通过 bridge 打开 `file://` HTML fixture、Markdown/无扩展名文本 fixture 和本机目录 fixture，并验证无法预览的本地文件会弹出 toast 而不是进入下载列表。测试结果会写入 `embedded-browser-agent-result.json`。

`renderer-storage` checkpoint 使用真实打包 Electron 写入模型、草稿和布局三类
`localStorage` 测试值，刷新持久化队列后重启 Core DSH。场景要求重启后的页面 origin
与重启前不同，再逐项验证三个值均已恢复；这样回归覆盖的是跨 origin 的桌面持久化，
而不是同一个 renderer 进程内的普通读取。

主桌面流程的短对话布局回归会保存 `short-conversation-00-ready.png`、`short-conversation-01-prompt-filled.png`、`short-conversation-02-completed-top-aligned.png` 和 `short-conversation-layout-metrics.json`。最后一个截图和 metrics 均在切走并重新打开对话后生成；门禁要求首条消息距离消息视口顶部不超过 `160px`。本地排查该回归时可直接运行 `node wework/e2e/desktop/run-checkpoints.mjs --short-conversation-only`，但该检查同时属于常规 `e2e:desktop` 主流程，不是独立 CI 入口。

主桌面 runner 也支持按有序 checkpoint 分段执行。当前 checkpoint 依次为
`remote-device-onboarding`、`workspace-tabs`、`cloud-project-creation`、
`cloud-space-mention`、`priority-filter`、`telemetry-consent`、
`automation-lifecycle`、`project-automation`、
`project-assignment-notification`、`offline-local-project-space`、
`core-dsh-plugin-management`、`plugin-auto-update`、
`plugin-workspace-publication`、`project-ai-settings`、`model-routing`、
`permission-modes`、`computer-use`、`task-status-sync`、
`task-board-association`、`core-task-flow`、`task-attachments`、
`cloud-git-worktree`、`cloud-worktree-capability`、`cloud-worktree-create`、
`cloud-worktree-queued-cancel`、`cloud-worktree-tools`、
`cloud-worktree-archive-restore`、`context-compaction`、`runtime-task-queue`、
`executor-stream-recovery`、`running-conversation-history`、
`codex-notification-isolation`、`split-workbench`、`native-window-startup`、
`native-window-chrome`、`renderer-storage`、`tray-lifecycle`、
`window-lifecycle`、`goal-lifecycle`、`supervisor-lifecycle`、`resilience`、
`conversation-state`、`temporary-chat`、`workspace-attachments`、
`rendering-extensions`、`change-request-status`、`claude-runtime`、
`local-file-preview`、`local-harness`、`harness-apps`、`browser-multi-tabs`、
`embedded-browser` 和 `browser-toolbar-actions`。
`--segment <checkpoint>` 在公共启动和项目初始化后只运行指定 checkpoint；
`--from-segment <checkpoint>` 从指定 checkpoint 开始并继续执行所有后续
checkpoint。跳过上游时，每个 checkpoint 会自行建立最小前置 fixture，不依赖只有
完整流程才创建的任务或 UI 状态。PR CI 会根据改动的功能路径组合最小 segment
矩阵；共享桌面基础设施、merge queue、定时任务和 `ci:all` 仍运行完整桌面套件。
Core 和 Cloud 的分片定义以 `.github/scripts/classify-wework-desktop-e2e.sh` 为准。
Linux Core 和 Cloud job 最多并行运行 4 个彼此隔离的 checkpoint，实际并发还受
分片内 checkpoint 数量限制。每个 checkpoint 使用独立的数据库、Redis、端口和运行目录，
Harness runtime 在分片启动前统一解压，因此不再因“重型运行时”或“协作”分组而全程串行。
macOS 中需要争用原生桌面前台的 checkpoint 仍通过资源锁保持串行。

`split-workbench` 含固定 3 秒的拖拽交互性能断言，使用独立 Linux 分片，
避免其他全栈实例争抢 CPU 改变性能基准。它仍保留完整功能断言，并记录拖拽移动、
松开事件分发和分屏就绪的分阶段耗时；其他功能分片仍可运行最多 4 个实例。
各 Core/Cloud matrix job 还提供跨 runner 的套件级并行。Core 使用 10 个分片（Windows
复用相同矩阵），Cloud 使用 8 个分片。合并短分片可复用容器初始化、代码检出、
构建产物下载和运行时准备，不增加每台 runner 内的 checkpoint 并发数。性能基准的
2 个 Core 分片以及账号认证和长插件列表的 3 个 Cloud 分片仍独立运行。
并发上限必须不低于完整矩阵的分片数，避免配置强制分批；分类器回归测试同时检查
分片预算和此约束。共享 runner 池仍可能引入外部排队。
Lint、单元测试、平台 E2E 和桌面 E2E 的汇总 job 使用 `always() && !cancelled()`：
测试失败时仍汇总结果，workflow 被新提交取消后停止排队，避免旧汇总阻塞新提交。
清理和诊断上传步骤继续使用原有的取消处理方式。

成功 CI 记录 `39920301020` 和 `39920742402` 的逐步骤耗时用于拆分环境开销。
前者 42 个分片的非测试步骤合计约 60 机器分钟，占分片执行量约 31%；后者的
环境开销更高。最终 18 个分片减少了 24 次环境准备。

按 `39930854745` 的各 checkpoint 耗时重新分配任务，采用长任务优先和累计工作量
平衡，并保留 CLI、Electron 准备的合并复用。`workspace-tabs` 在该轮因切换看板后
未等待创建按钮就绪而提前失败，分组计算采用 `39920301020` 中成功的 116 秒，
不把失败耗时当作完整场景耗时；该点击使用现有 `clickWhenEnabled` 等待，保留默认
10 秒超时和业务断言。112 个普通 Core checkpoint 总计 10246 秒，分到 8 个分片，
每片 14 个任务、同时运行最多 4 个，估算为 323～332 秒；增加到 9 片仅把最长估算
缩至 320 秒。37 个普通 Cloud checkpoint 总计 5769 秒，分到 5 片估算为 291～339 秒；
增加到 6 片仅把最长估算缩至 321 秒。其余 2 个 Core 和 3 个 Cloud 分片保持隔离。
上述调度估算不含每片环境准备及运行时资源波动，不能视为实测收益。
后台终端历史验证依据首个可见 xterm 行的 `aria-posinset`，逐次原生 PageUp 后等待
行号严格减小，直到历史顶部。每次操作仍使用默认 10 秒超时，再完整断言第 1～12 条
输出，并通过原生 PageDown 返回。不能用一个 10 秒总期限限制多次翻页：并发 CI 中，
控制链路延迟可能使循环在历史仍存在时提前停止。该情形由慢控制链路、滚动停滞及
历史缺失的聚焦回归覆盖。
分片按 CI 实测耗时平衡；新增或明显变慢的 checkpoint
必须重新校准分片，不能靠删覆盖或重跑失败用例来缩短关键路径。
长场景按独立行为拆成 checkpoint，而不是只调整分片：
同步 main 后新增的 `stand-in-project-enable` 尚无历史样本，与第 3 片的分身配置流程
合并复用准备；该片现有 15 个任务，其余普通 Core 分片为 14 个。上述估算不含此新增场景。

- `plugin-account-auth` 展开为密码同步、独占凭据迁移、OAuth、钉钉账号、对话扫码和 GitHub 六个 checkpoint。
- `plugin-uninstall-resilience` 展开为写入争锁、响应丢失、结果未知、重启恢复和重装竞态五个 checkpoint。`plugin-write-coordination` 独立验证争锁期间 API 响应、提交后的 ACK 冲突及后续同步恢复；卸载恢复用例自行建立另一个仍有效的安装，覆盖目录刷新与待清理任务并存的情况。
- `harness-apps` 展开为开发流程与安装运行生命周期两个 checkpoint。
- `streaming-text` 展开为内容、工具详情、计时、滚动、消息顺序和子智能体六个 checkpoint。

每个 checkpoint 都从隔离环境建立自己的前置数据。上述组名仍可用于 `--segment`，
`--from-segment` 从该组第一个 checkpoint 开始；CI 则直接调度各独立 checkpoint。
各分片复用同一份构建产物，减少重型流程在同一 runner 上的 CPU 争抢。
24 插件长列表仍验证全部条目、滚动和末项选择；启停及两次重启后的持久化改由
`plugin-toggle-persistence` 使用一个插件独立验证，避免重复同步整个长列表。
Linux Core/Cloud 测试在开始、结束和每 15 秒输出 `[runner-resources]` JSON 记录，
并保存到诊断产物中的 `runner-resources.jsonl`。Web 分片复用同一采样器，设置
`RUNNER_PROCESS_DIAGNOSTICS=1` 后额外记录 PID、父 PID、状态、运行时长和进程名，
不记录命令参数。`RUNNER_RESOURCE_LOG_PATH` 可指定日志路径；Web 日志保存在独立的
`e2e-process-diagnostics-*` 产物中，便于定位测试结束后命令未退出的问题。
记录包含 CPU 使用率、load average、
内存、磁盘可用空间、Linux CPU/内存/I/O 压力及 cgroup CPU 限额、内存峰值和 OOM 计数；
不可读取的内核指标会记录 `unavailable`。CPU 使用率是两次采样间的平均值，首次记录为 `null`。
`[desktop-e2e-schedule]` 日志在 checkpoint 启停时记录活动列表和实际并发数，可用于确认
测试是否真正重叠；不能只凭配置的并发上限推断并行效果。提高并发后需要对比同一分片的
耗时和这些指标，确认没有把等待转成 CPU、内存或 I/O 争抢。
抽屉动画逐帧检查从操作前持续采样，观察到位移且轨道动画结束后主动停止；采样上限沿用
共享单步超时。这样命令传输和渲染延迟不会耗尽固定的 800ms 采样窗口；位移、连续性、
中间帧和减弱动态效果的断言仍完整执行。
包含 2200 个增量的
Codex 通知隔离压力场景和耗时较长的插件自动更新 checkpoint 各自使用独立分片；
通知场景使用定向的 30 秒渲染预算，不改变共享的 10 秒 UI 超时。CI 会先构建一次 Core Electron
应用、Executor 和 Codex artifact。Electron 打包会并行准备 Harness runtime、
Node execution runtime 和 Executor；Harness 准备流程负责唯一一次 DSH 应用 Vite
构建，避免重复编译同一前端。各 Core/Cloud 分片下载并复用该 artifact，不再重复
执行 Vite、Electron 和 Executor 构建。桌面分片依赖共享构建成功后才启动，并通过
GitHub artifact action 直接下载产物；这避免大量 runner 在构建期间空占资源轮询，
让 Lint、Tests 和 Platform E2E 能及时获得 runner，同时不增加 matrix job 数量或
减少任何 checkpoint。Rust gateway 和 Executor 都以 debug
profile 构建，避免为 E2E 产物执行无用的 release 优化；测试产物还会关闭 dev
profile 的 debuginfo，因为诊断 artifact 不保留这些符号，生成后再剥离只会延长
冷构建。Rust 构建同时复用由 `main`
维护的 Cargo target cache 和 sccache 编译单元：target cache 保障 PR 与首次
运行的延迟，sccache 降低依赖或源码变化后的增量编译成本。归档时只移除复制到
artifact 中的 Linux debug symbols，原始构建产物保持不变，以缩短所有桌面分片的
上传和下载时间。`backend-rs/**` 或 `executor/**` 的源码变化会选择桌面 target
cache warmup，防止主分支只在 lockfile 变化时刷新缓存。桌面 E2E 和对应的 cache warmup 显式设置
`WEWORK_EXECUTOR_PROFILE=debug`，避免为测试 artifact 优化 Executor；正式打包
不设置该变量，继续默认构建 `release` Executor。桌面 E2E 构建跳过由并行 Lint
工作流完整执行的重复 TypeScript
类型检查，只保留 Vite/ Electron 的真实产物构建；测试覆盖与类型门禁均保持不变。
macOS Inspector 与内存 E2E 的共享构建使用 release Executor，保证内存测量使用
优化后的代码。macOS 内存任务会同时使用 workspace 与 Electron lockfile 生成 pnpm store key，
并离线安装依赖，避免 registry 卡顿耗尽关键路径预算。其大段流式 Markdown 响应使用
定向的 30 秒完成预算，普通内存测试交互仍保持共享的 10 秒超时。插件套件需要独立构建配置，仍作为
单独 job 与共享 Core 构建并行。桌面分片只使用不可变 E2E 镜像中已有的运行时工具；
ZIP fixture 改用 Python 标准库，因此不再恢复完整前端依赖缓存。Harness app 的成功
路径保留关键里程碑截图，每次运行仍保留日志、状态快照和其他有效诊断；上传前只清理
无法帮助复现问题的 Chromium 临时缓存。PNG 等已压缩文件上传时禁用二次压缩，避免
诊断归档延长流水线尾部。
merge queue 会验证最终进入 `main` 的合并提交，因此合入后不再通过 `push main`
重复运行同一套 Tests、Lint、Platform E2E 和 Wework E2E。保留 `ci:all` 标签后，后续 push 也会运行完整 Windows Core 分片。
macOS 的 pre-push 检查通过 `caffeinate -is -w` 保持执行期间唤醒，hook 退出时自动释放，避免系统休眠造成测试超时。
Windows 构建、分片和汇总检查共用同一个运行条件，预期任务被跳过时门禁失败。
Issue MCP 附件场景在 Linux 和 Windows 均通过共享 `setup-minio-e2e` Action 构建并验证同一固定版本的真实 MinIO；仅 main 写入缓存，场景通过 `WEWORK_E2E_MINIO_BIN` 使用当前平台的可执行文件。
macOS 内存检查直接调用 Node checkpoint runner，构建缓存命中时无需 pnpm。映射规则位于
`.github/scripts/classify-wework-desktop-e2e.sh`，新增功能覆盖时
必须同步登记对应 segment。新增 `DESKTOP_CHECKPOINTS` 检查点时，必须同时把它加入
Core、Cloud 或正式发布 catalog，分配到对应 shard，为相关源码路径增加最小分类，
并更新 `.github/scripts/test-classify-ci-changes.sh` 的矩阵期望和专用分类断言。
分类器会拒绝只注册在运行器、但没有 CI catalog 覆盖的检查点，避免本地可运行而
GitHub CI 永远不执行的死覆盖。分段命令也可用于本地快速迭代：

```bash
pnpm --filter wework e2e:desktop -- --segment automation-lifecycle
pnpm --filter wework e2e:desktop -- --segment local-harness
pnpm --filter wework e2e:desktop -- --segment model-routing
pnpm --filter wework e2e:desktop -- --segment window-lifecycle
pnpm --filter wework e2e:desktop -- --from-segment window-lifecycle
pnpm --filter wework e2e:desktop -- --segment temporary-chat
pnpm --filter wework e2e:desktop -- --segment workspace-attachments
pnpm --filter wework e2e:desktop -- --segment claude-runtime
```

`automation-lifecycle` 独立覆盖自动化创建、立即执行、固定既有任务以及定时继续
会话；`model-routing` 独立覆盖六种本地协议切换方向、跨 provider 重试、视觉
sidecar 和本地模型协议矩阵。两者都建立自身最小 fixture，因此不会拉长
`core-task-flow` 的任务创建、追问和后台计划关键路径。无参数运行完整桌面流程时，
这些场景仍会执行，不会因为分段而减少覆盖。

`temporary-chat` 使用独立本地项目和真实 Codex ephemeral thread，保持 follow-up
回复处于流式运行状态，验证 user message 在“正在思考”之前显示，并在切换主会话后
验证临时聊天内容仍从运行时会话缓存恢复。

`claude-runtime` 使用真实 Electron Wework、Backend、local executor 和 remote
executor，验证 Claude Code 在本机与远程设备上的创建、追问和取消路径。场景还会
确认远程执行使用目标设备自己的 Claude Code binary，并以可见 DOM 为准检查任务
完成后侧栏和 composer 不再显示 running；布局保留的隐藏 sidebar preview 不计入
可见状态断言。

`local-harness` 使用 `.github/claude-code-cli/package-lock.json` 固定的真实
OpenCode、Claude Code 和 Kimi Code CLI，不允许用只记录参数的 shell fixture
代替。场景必须断言每个 CLI 通过 Wework 本地模型代理发出的真实请求。Kimi Code
以交互 TUI 启动，首条 prompt 只能在 PTY 输出出现其就绪标记后注入；终端能力握手
期间提前写入会丢失输入。

插件桌面套件也复用同一套分段参数，但保持独立的 Codex Home 初始化环境。插件
segment 依次为 `plugin-lifecycle`、`skill-mention-rendering` 和
`sites-plugin-auto-install`。每个 segment 都会建立自身所需的最小插件 fixture，
可以单独运行，也可以从指定功能继续执行后续插件功能。`plugin-lifecycle` 额外覆盖：
卸载后 Composer 插件选择器不再列出该插件，以及助手消息携带无匹配身份的
`need_login` / `connector_auth_required` 时不误弹本地授权卡。

```bash
pnpm --filter wework e2e:desktop:plugins -- --segment skill-mention-rendering
pnpm --filter wework e2e:desktop:plugins -- --from-segment skill-mention-rendering
```

桌面 runner 的普通 UI 步骤默认在 10 秒后超时，避免单个失败步骤统一等待
120 秒。控制命令和等待 helper 都可以通过 `timeoutMs` 为确实较慢的特殊步骤设置
独立上限；启动、工作台恢复和模型协议矩阵等场景使用各自的专用超时。临时排查慢速
环境时，可通过 `WEWORK_E2E_STEP_TIMEOUT_MS` 调整普通步骤的全局默认值。

首次模型路由任务与真实 Harness CLI 启动使用工作台启动预算；流式滚动先等待模型请求，再使用原有 10 秒预算校验界面。切换项目后等待执行模式按钮可用；看板卡片移列后先滚动到结果再校验可见性。云端分身复用自适应视图选择 helper，兼容紧凑下拉框。失败工作台快照附带资源请求的连接、发送与响应时序，记录请求源和路径，不记录查询参数。最近 250 条请求附带浏览器时间原点；内部缓冲扩大到 5000 条，避免启动资源占满默认容量后丢失失败阶段的请求。

进程浏览器的纯数字筛选精确匹配 PID，避免匹配其他进程的启动参数或 PID 子串；文字筛选仍搜索进程名和启动信息。应用菜单检查点保留按主进程 PID 排除无关 helper 的断言。

主桌面流程还覆盖从 Finder 粘贴或拖入普通文件和文件夹：输入框必须显示文件与文件夹路径标签，不得创建附件徽标；发送给 Codex 的请求必须包含对应绝对路径，且不得内联文件内容。该判断以桌面原生传输是否解析出文件路径为准，不能仅因输入框当前标记为远程工作区就提前改走附件上传。顶部快捷发送窗口复用相同规则，只读取图片附件的字节。相关场景均使用普通小文件，本地聚焦排查可分别运行 `node wework/e2e/desktop/run-checkpoints.mjs --pasted-workspace-paths-only` 和 `node wework/e2e/desktop/run-checkpoints.mjs --dropped-workspace-paths-only`。

mock 会按 cc-switch 的转换边界严格校验模型侧收到的请求，包括鉴权、模型 ID、stream 参数、消息历史、tool choice、shell 工具，以及 `apply_patch` 的 Lark grammar 或 function wrapper。任何字段错误都会返回非 2xx 并使测试失败。桌面测试同时保存三种接口的追问截图和完整 `model-requests.json`；GitHub Actions 无论成功或失败都会上传桌面诊断产物。

运行环境需要 Rust、 Electron 构建依赖和真实 Codex 二进制。默认从 `PATH` 查找 `codex`；也可以显式指定已安装或由 `prepare:codex` 准备的真实二进制：

```bash
CODEX_BIN=/absolute/path/to/codex pnpm --filter wework e2e:desktop
```

桌面 runner 在未配置二进制时会先运行 `ai:verify:electron:build`，校验打包后的真实
Electron 应用及其内置 Executor，再启动所选场景。可选的 `WEWORK_E2E_EXECUTOR_BIN`
和 `WEWORK_E2E_APP_BIN` 必须成对设置，用于复用已经构建的真实 Executor 和真实
Electron 应用；传入的应用必须使用桌面 E2E 的 Vite 环境变量构建。各生命周期场景
复用一次应用启动以控制 CI 时长；测试过程、捕获的模型请求和失败诊断会保存在
`wework/test-results/desktop-e2e/`。场景结束后会保留日志、截图、请求和 UI 状态，
同时删除复制的应用包、Executor Home、工作区夹具、测试归档、解压 Runtime 和其他
顶层可重建测试环境。`electron-user-data` 仅保留诊断状态；主实例和插件开发子实例中
物化的 `managed-components`、`managed-runtimes`、DSH/Harness profile 和 Electron
缓存都会递归删除。runner 启动时也会清理之前异常中断留下的非活动结果目录，避免
本地磁盘随运行次数持续增长。

Linux CI 的插件开发分片通过 GDB 启动受 Electron 管理的 Executor，原生崩溃时
将所有线程的栈写入 Executor 日志；启动前先验证 IPC 文件描述符能够传入被调试
进程。独立 MCP 和 schema 查询保持原有 stdout 协议。栈诊断不打印参数或局部变量。
桌面 E2E 的 Electron 日志同时保留脱敏后的 renderer 错误；Git worktree 和会话索引
替换失败会记录 Git stderr 或原始系统错误码，便于区分页面超时与底层执行失败。
Windows 插件安装诊断还会记录 pnpm 操作前后的应用资源目录状态、目录链接目标和
文件数量；静态资源读取失败时会记录父目录链接状态，用于定位资源缺失发生的阶段。
Windows 组件组合目录和托管插件副本都持有独立资源文件，避免 pnpm 清理目录链接时
删除共享组件内容。布局指纹和副本版本标记会使旧目录重新构建；插件开发 E2E 验证
隔离窗口启动后主应用资源保持完整，Windows 资源目录不再链接到共享组件。
Windows worktree 命令通过现有 `.git` 和 `commondir` 解析结果显式传入
`GIT_COMMON_DIR`，让 checkout 子进程在加载仓库配置前找到共享对象目录；传给 Git 的路径
先移除 Windows verbatim 前缀，避免 Git 拼接 `/config` 后形成无效的扩展路径。
工作树删除、恢复及快照引用清理在共享 Git 目录中使用短参数 `--git-dir .`，避免 Git
在加载配置前拒绝过长的显式目录参数；工作树目标路径保持绝对路径。
Windows 会话索引使用 `FileRenameInfoEx` 的 POSIX 替换语义发布新文件，保证旧读者仍能
读取完整旧索引、新读者立即看到新索引。目标父目录先规范化，为直接 Win32 调用保留
长路径前缀，包括首次创建索引。原生 CI 覆盖持有旧文件句柄时连续替换及长路径替换。

插件缓存变更会重启 Codex app-server，因此同步必须同时等待 AI 任务和后台终端结束。
回归测试验证后台进程仍运行时延后更新、收到原生退出通知后才发布新插件文件；
桌面场景保留窗口重载后读取输出和停止进程的完整断言。
Windows 测试使用跨 shell 的终端命令并确认独立输出行，设置控件先滚动到可见区域。
Git fixture 明确关闭自动换行转换，队列和侧栏 fixture 明确选择测试模型，保持原有行为断言。
桌面 fixture 显式绑定本次临时 Home 下的工作区根目录，并清除宿主继承的其他路径覆盖，
避免读取旧测试或个人工作树。任务准备失败记录原始错误码和原因，避免只留下页面等待超时。
CI 在环境准备阶段验证开发 Electron 二进制，避免场景内首次导入时才下载。

远程协作场景在打开智能体表单前，通过真实 Backend 完成执行环境目录初始化，
并验证目标远程设备已获授权。原生模型目录冷启动不占用表单的 10 秒 UI 步骤预算。
桌面启动失败时，`scenario-state.json` 记录应用进程的启动、退出时间和退出码；
Windows 同时保留 `electron.log`，用于定位 renderer 连接之前的原生启动失败。
迁移 fixture 使用 `HOME` 指定隔离的工作台数据目录，保留操作系统的 `USERPROFILE`。
控制器先回传当前动作结果，再轮询下一条命令，避免未完成的长轮询占用结果回传连接。
系统代理场景和任务状态同步的初始模型请求等待使用模型阶段预算，普通 UI 步骤仍保持 10 秒。
初始任务与后续消息复用 `sendPromptUntilScenarioRequest`，在发送前注册请求监听，
并使用共享的 30 秒模型请求时限。
后台引导等待真实工具输出及其后的模型请求时，同样使用模型请求预算；原生工具可能在
10 秒后返回仍在执行的会话，不能把该工具阶段套用普通 UI 步骤时限。
消息顺序场景先以模型请求预算等待当前轮的 SSE 响应发送完成，再以原来的 10 秒 UI 预算等待正文；响应序号必须对应当前轮。HTTP 诊断保留请求开始、结束和耗时，避免把 Codex 执行阶段的延迟误判为虚拟列表漏渲染。
流恢复场景在首次发送前显式选择已注册的 fixture 模型；编辑器出现不代表模型目录已就绪。
模型选择完成后，仍验证流式回复在 renderer 重载期间继续执行并恢复完整输出。
应用重启后的续写先等待发送控件可用，再发送一次 Enter；输入文字稳定不能代表模型目录已恢复。
模型请求监听与发送动作同时等待，任一失败都进入原有诊断与清理流程，避免未处理的 Promise
拒绝直接退出 Node 并丢失失败快照。模型请求等待超时后停止内部轮询，避免残留定时器。
普通发送控件等待仍使用 10 秒步骤时限。
恢复原生模型目录默认值时，目录刷新会暂时卸载模型行。场景从稳定页面快照等待原模型行
重新出现且不再显示自定义标记，然后继续验证原生数据和磁盘持久化结果。
过载恢复场景的新会话取消阶段也单独选择 fixture 模型，不继承上一会话的模型状态。
动作执行与结果回传分别记录：回传失败不能再次发送伪造的动作失败结果。
E2E 的 Electron 日志保留 loopback 请求的网络错误码和路径，不记录请求头或查询参数。
Windows 失败产物中的 `windows-network-diagnostics.json` 只记录 TCP 状态与进程的连接数量，
用于定位 Winsock 资源不足，不包含连接地址。
任务看板批量操作在每次输入前确认空会话已经激活，不能只等待编辑器节点存在。
Goal 重启场景必须同时观察一个任务运行、另一个任务排队后，再释放占用单槽的模型响应。
工作列表刷新保留已打开工作区的执行设备，防止较早的刷新结果覆盖新的云端工作区选择。
工作台和会话诊断快照共用 100ms 发布调度，持续状态更新不能取消已排定的发布；每次发布读取最新状态。停用诊断或卸载组件时取消待发布任务，避免后台会话覆盖当前快照。会话标题隔离断言失败时保留回复数量基线及每次轮询的标题、生命周期和消息摘要。
手动重命名会话在持久化后发送已有的 `runtime.task.title.updated` 事件，使其他工作台立即同步私有会话标题。终端翻页诊断复用 `runtime-launch.log`，只记录按键阶段、实际视口、无障碍行号和尺寸，不记录终端输出。原生送键等待目标元素收到可信键盘事件，并同时确认主机调用成功；不依赖固定 16ms 定时器判断完成。事件缺失仍使用 10 秒动作预算，并在成功或失败后释放监听器。后台终端检查启用隔离主线程 CPU 采样，每 5 秒在 Electron 日志目录保存一个 `.cpuprofile`，用于定位请求已结束但 JavaScript 长时间未恢复的调用栈。采样移除 URL 凭据和查询参数；普通桌面会话不启用调试器。
诊断记录项目选择的 reducer 动作和 ID、输入草稿所属会话及父层确认版本，以及 Codex
app-server 的启动进程 ID、初始化失败时的退出状态和 Windows 进程树终止失败状态。
配置归一化和替换记录文件大小、模型及内置 OpenAI 地址字段是否存在；替换还记录调用位置，不记录配置正文。
仅配置文件不存在时才初始化空配置；其他读取失败直接报错并保留原文件。回归使用无效 UTF-8 触发真实读取错误，验证启动被阻止且原始字节不变，避免归一化悄悄清除模型地址。
`codex-invalid-launch-cwd` 在启动前、执行器重启前后及发送前记录隔离配置的摘要和 fixture 字段是否匹配，并读取原生配置层的来源及字段存在状态，以区分磁盘配置变化与运行时加载异常。
Codex app-server 的重启和配置变更持有任务准入锁，等待旧进程退出后才允许新进程启动。
失败产物 `codex-sqlite-diagnostics.json` 记录隔离 SQLite 文件大小、只读完整性检查结果
和 SQLite 错误码，不读取会话表内容。Executor 兼容性查询失败仅记录耗时、退出码、信号和终止标记，
不记录子进程输出、命令路径或环境变量。

Executor 在创建 Tokio 运行时之前配置回环地址的 `NO_PROXY`，避免连接期间在异步线程中
修改进程环境。启动场景验证 Executor 先就绪、Core DSH 后启动，并确认实际监听端口有效。
阻断代理启动场景先验证工作台无需等待 Codex 网络，再释放代理并等待本地插件注册完成，
最后清除代理配置，避免测试前置操作中断仍在进行的初始化。

Core DSH 使用端口 `0` 直接绑定操作系统分配的端口。Electron 读取 DSH 的实际
监听地址后再逐项验证 host、Executor、Terminal 和应用入口，不通过提前打开再关闭
监听器探测端口，避免并行启动时其他服务抢占已探测的端口。

Linux 云端测试的后端、数据库等服务需要在启动前公布端口。共享分配器读取
`/proc/sys/net/ipv4/ip_local_port_range`，在内核动态端口范围之外选择可绑定的
非特权端口，并通过端口注册目录隔离并行 checkpoint，避免服务初始化期间被
Core DSH 等使用端口 `0` 的进程抢占。

GitHub Actions 上传前会再次执行同样的清理，并在 Artifact 路径中排除
任意深度的 `managed-components`，防止 teardown 失败时把主实例或插件开发子实例的
完整 Web/WASM 组件包上传为诊断证据；顶层清理和 Artifact 路径也都会排除测试 `.zip`
归档。诊断 Artifact 使用标准压缩，正常目标是不超过 20 MiB；诊断包只应包含日志、
截图、请求、UI 状态和必要的 Electron 持久化状态，不应包含任何可重新构建的应用、
Runtime、Executor Home、工作区、测试归档或组件目录。

本地 runner 会把前置 Electron 和 Executor 构建的完整 stdout、stderr 写入
`wework/test-results/desktop-e2e/desktop-build-<pid>.log`，终端只显示构建阶段、
每 30 秒一次的存活提示、耗时和日志路径，避免包安装、编译和签名输出淹没 checkpoint
结果。构建失败时，终端还会打印日志末尾的有限摘要；场景启动后的测试输出仍实时显示。

`ai:verify:electron:build` 会跨 worktree 复用不可变的 Harness Runtime 归档，macOS 默认缓存到 `~/Library/Caches/wegent/harness-runtime`，Linux 默认缓存到 `${XDG_CACHE_HOME:-~/.cache}/wegent/harness-runtime`，Windows 默认缓存到 `%LOCALAPPDATA%\wegent\harness-runtime`。解压后的开发 Runtime 仍保留在当前 worktree 的 `wework/node_modules/.cache/harness-runtime-dev`，避免不同源码树共享可变状态。可通过 `WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT` 覆盖归档缓存目录；若构建时只设置了旧的 `WEWORK_HARNESS_RUNTIME_CACHE_ROOT`，该值会被转换为仅用于归档的缓存目录，不会改变当前 worktree 的解压目录。

桌面 E2E 启动 Electron 前会移除父进程中的任务、IPC、Node 和 Harness runtime 环境变量，避免从开发中的 Wework 或 Codex 会话继承个人运行时路径。需要为聚焦排查显式指定 Core DSH runtime 时，使用 `WEWORK_E2E_HARNESS_RUNTIME_ROOT`；runner 会校验该目录并将其作为测试应用的 `WEWORK_HARNESS_RUNTIME_ROOT`。不要直接向测试命令传递 `WEWORK_HARNESS_RUNTIME_ROOT`。

在 macOS 上，桌面 E2E 默认注入测试专用的 `WEWORK_E2E_BACKGROUND_WINDOW=1`，让 Electron 保持主窗口隐藏、禁止应用激活并隐藏 Dock 图标；隐藏 WebView 会关闭后台节流，因此 DOM 控制、计时器和截图仍正常工作。需要观察真实窗口交互时，可显式设置 `WEWORK_E2E_BACKGROUND_WINDOW=0` 恢复前台运行。该环境变量只影响桌面 E2E，不改变正常开发或生产启动行为。

云端项目场景会启动真实 Backend、Redis 和一个注册为远端设备的真实 Executor，通过真实鉴权、设备 RPC、任务持久化和项目删除接口完成创建项目、执行任务、恢复会话、连续追问与删除项目验证。场景同时验证云端 Model CRD 经 backend 代理转发三种模型协议，以及同一云端账号下的 Codex/云端模型在本机 executor 中执行。测试只模拟 provider 模型端点；不得模拟 Backend HTTP 或 WebSocket 接口。为缩短冷启动时间，Executor 构建与 Backend/Redis/数据库准备并行，远端 Executor 注册与 Electron 应用构建并行；应用启动前仍必须同时等待两组前置任务完成。清理项目之前必须等待任务的运行状态结束；助手文本已经渲染并不代表任务状态已经完成持久化。运行该场景需要 Python 3.11、`uv` 和 `redis-server`。

混合 Backend 启动脚本会把 Python Uvicorn 的上游 HTTP keep-alive 设为 2400 秒，
长于混合 E2E workflow 最长的 35 分钟 job。`brz-http-gateway` 0.1.4 创建
hyper-util 连接池时没有安装空闲连接计时器；如果 Uvicorn 先让空闲 socket 过期，
gateway 可能复用已经被上游关闭的连接，并把请求错误地返回为 `502 fallback
upstream unavailable`。让本地启动器的上游连接生命周期覆盖整个 job，可消除该
测试运行中的陈旧 socket 窗口。该设置只约束本机 Rust → Python fallback 连接，
不改变外部客户端到 gateway 的连接复用。

云端场景在验证连接账号下的本机执行模型之前，会通过当前“项目 → 本地项目”入口选择隔离目录，并在本地项目创建对话框中确认名称。桌面 E2E 应复用这个产品主流程，不得继续依赖已经移除的“已有项目”测试入口。

`plugin-account-auth` 场景使用仅在 E2E 标记文件启用时生效的调度间隔，并在测试
明确改变凭据状态后发送一次精确 retry signal；生产环境仍保持 15 秒自动同步周期和
60 秒失败退避。DWS 手工撤销验证不再固定等待 32 秒，而是
等待真实 Executor 写出两次已完成的 reconciliation 标记，并在期间持续断言授权没有
被自动恢复；因此缩短的是空等时间，不是账号迁移、云端执行或撤销覆盖。

GitHub Actions 的 Executor E2E job 会在恢复 Python、Node.js 和 Playwright 缓存后加载预构建 Docker 镜像。该 job 必须先删除不使用的 hosted-runner SDK（.NET、Android、GHC 和 CodeQL）并记录磁盘用量，为镜像解压保留稳定空间；清理逻辑不得删除正在运行的 MySQL 或 Redis service 镜像。

插件场景会在测试结果目录动态创建隔离的本地 Codex marketplace 和带 Skill 的插件，然后通过真实 Electron renderer、Executor 与 Codex app-server 验证市场展示、安装、安装时本地授权对话框、在对话编辑器中插入插件引用、无匹配 resume 不弹本地授权卡、卸载后 Composer 过滤及卸载。场景不访问个人 Codex home，也不 mock 插件 API；市场、插件缓存和安装状态都随测试结果目录清理。关键阶段会保留截图，失败时同时保留应用、Executor 和 UI 快照诊断。

内存场景仅支持 macOS。它会保持底部 Terminal 挂载，通过真实 Codex 工具调用执行一个开发任务，再向真实 Electron renderer 流式发送包含 Markdown、表格和 TypeScript 代码的长回复。测试先等待 Web Content 内存基线稳定，再每 500 毫秒采集 Wework 关联的全部 Electron renderer 进程的聚合 physical footprint；同一次采样会通过 Electron DevTools Protocol 强制执行 renderer GC，并读取实际 JS heap 使用量。采样、DOM 节点数、当前 assistant 内容摘要和汇总指标写入 `memory-growth.json`；门禁不包含 Wework 主进程。默认门禁为 physical footprint 峰值增长不超过 384 MiB、完成后的稳定态增长不超过 232 MiB、稳定窗口内最大波动范围不超过 16 MiB，以及整个输出阶段强制 GC 后的 JS heap 峰值不超过 200 MiB。DOM 门禁检查虚拟列表收敛后的稳定窗口，默认相对基线不得新增超过 576 个节点；流式渲染期间的瞬时峰值仍会记录在诊断中，但不会把收敛前的短暂渲染误判为泄漏。各阈值可分别通过 `WEWORK_E2E_MEMORY_MAX_PEAK_GROWTH_KIB`、`WEWORK_E2E_MEMORY_MAX_SETTLED_GROWTH_KIB`、`WEWORK_E2E_MEMORY_MAX_SETTLED_DOM_NODE_GROWTH` 和 `WEWORK_E2E_MEMORY_MAX_JS_HEAP_BYTES` 调整。聚焦复现超长流时，可通过 `WEWORK_E2E_MEMORY_SECTION_COUNT` 和 `WEWORK_E2E_MEMORY_CHUNK_DELAY_MS` 调整回复段数和分段间隔；完成预算固定为 30 秒，不能通过环境变量放宽。

并发内存场景同样仅支持 macOS。它会创建并同时保持 10 个 Responses 流，采集 Wework 主进程、Electron renderer/GPU/network、Executor 和 Codex app-server 的进程组 physical footprint，并将证据写入 `concurrent-memory.json`。相对于稳定基线，峰值和活跃稳定平台的增长都不得超过 320 MiB，稳定采样窗口内的波动不得超过 64 MiB；可分别通过 `WEWORK_E2E_CONCURRENT_MEMORY_MAX_PEAK_GROWTH_KIB`、`WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_GROWTH_KIB` 和 `WEWORK_E2E_CONCURRENT_MEMORY_MAX_SETTLED_SAMPLE_RANGE_KIB` 调整。场景还会在首尾任务之间切换，并等待各自的 prompt 内容重新出现。

## Responses API Mock

`wework/e2e/utils/mock-response-api-server.mjs` 提供真实 HTTP 服务，用于验证本地模型能力探针请求：

- `POST /v1/responses`：返回非流式 Responses API JSON。
- `POST /v1/responses` 能力探针：返回 `text/event-stream` 工具调用事件，例如 `response.output_item.added` 和 `response.output_item.done`。
- `POST /v1/responses` 且 `stream: true`：返回 `text/event-stream`，事件包含 `response.created`、`response.output_text.delta` 和 `response.completed`。
- `POST /v1/chat/completions`：校验并返回 Chat Completions function tool call。
- `POST /v1/messages`：校验并返回 Anthropic Messages `tool_use`。
- `GET /captured-requests`：读取已捕获请求。
- `POST /clear-requests`：清空捕获请求。
- `GET /health`：CI health check。

该 mock 开启 CORS，因此 Wework 页面可以直接从浏览器环境发起真实 `fetch`。测试模型配置时，base URL 使用：

```text
http://127.0.0.1:9998/v1
```

## 外部 Upstream Mock

Wework E2E 还会启动两个本机 loopback upstream mock。它们只替代 Wegent 之外的外部服务，不替代 Wegent Backend、Executor、Codex、`/api/sites`、`/api/apps/installed` 或 connector runtime API。

`wework/e2e/utils/mock-sites-upstream-server.mjs` 模拟 Sites project API，并根据 `app_type` 返回站点或小程序列表：

- `GET /api/v1/projects/search`：返回确定性的项目列表，支持 `username`、`limit`、`sitename` 和 `cursor`。
- `POST /api/v1/projects/deploy/network`：更新项目内外网状态。
- `POST /api/v1/projects/update`：更新项目名称。
- `POST /api/v1/projects/del`：删除项目。
- `GET /captured-requests`、`POST /clear-requests`、`POST /reset`、`GET /health`：用于断言和重置。

需要通过真实 Backend 覆盖 Sites 链路时，让 Backend 使用下面的环境变量启动。注意这些变量必须传给 Backend 进程；传给 Vite 或 Playwright 页面不会配置 Backend。

```text
SITES_API_BASE_URL=http://127.0.0.1:9997
SITES_API_TOKEN=e2e-sites-token
```

示例：

```bash
cd backend
SITES_API_BASE_URL=http://127.0.0.1:9997 \
SITES_API_TOKEN=e2e-sites-token \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

`wework/e2e/utils/mock-connector-upstream-server.mjs` 模拟 connector 可连接的外部服务：

- `GET /api/tickets/{id}`：作为 HTTP connector upstream。
- `POST /mcp`：提供最小 Streamable HTTP MCP JSON-RPC 行为，支持 `initialize`、`tools/list` 和 `tools/call`。
- `GET /captured-requests`、`POST /clear-requests`、`GET /health`：用于断言和重置。

配置 connector app 时可使用：

```text
HTTP connector base URL: http://127.0.0.1:9996/api
MCP URL: http://127.0.0.1:9996/mcp
```

HTTP connector fixture 可以使用：

```json
{
  "slug": "ticket-http",
  "name": "Ticket HTTP API",
  "description": "E2E HTTP connector upstream",
  "enabled": true,
  "visibility": "all",
  "allowed_roles": [],
  "auth_type": "none",
  "transport": "http",
  "mcp_url": "http://127.0.0.1:9996/api",
  "oauth_scopes": [],
  "provider_headers": {},
  "tool_allowlist": ["get_ticket"],
  "http_tools": [
    {
      "name": "get_ticket",
      "description": "Get one mock ticket",
      "method": "GET",
      "path": "/tickets/{id}",
      "input_schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "expand": { "type": "boolean" }
        },
        "required": ["id"]
      },
      "argument_locations": {
        "id": "path",
        "expand": "query"
      }
    }
  ]
}
```

MCP connector fixture 可以使用：

```json
{
  "slug": "docs-mcp",
  "name": "Docs MCP",
  "description": "E2E Streamable HTTP MCP connector upstream",
  "enabled": true,
  "visibility": "all",
  "allowed_roles": [],
  "auth_type": "none",
  "transport": "streamable-http",
  "mcp_url": "http://127.0.0.1:9996/mcp",
  "oauth_scopes": [],
  "provider_headers": {},
  "tool_allowlist": ["search_docs"]
}
```

## 自动化接口

测试模式下，Wework 会在 `window.__WEWORK_E2E__` 暴露前端控制接口。该接口只在 `import.meta.env.MODE === "e2e"` 或 `VITE_WEWORK_E2E=true` 时安装，普通开发和生产运行不会默认启用。

隔离真实 Electron 验证可通过 `ai:verify paste-paths` 或 `ai:verify drop-paths` 向输入框派发文件路径粘贴或拖放事件。`--value` 接收 JSON 数组，每项包含 `uri`、`name`，文件夹项还需设置 `isDirectory: true`：

```bash
pnpm --filter wework ai:verify paste-paths \
  --session /absolute/path/to/session.json \
  --selector '[data-testid="chat-message-input"]' \
  --value '[{"uri":"file:///tmp/context","name":"context","isDirectory":true}]'
```

把上例的 `paste-paths` 替换为 `drop-paths`，即可验证 Finder 拖放路径。

可用方法：

- `isDesktop()`：返回当前是否运行在 Electron 环境。
- `getRuntimeConfig()`：读取当前运行配置。
- `getRoute()`：返回去掉 app base path 后的当前路由。
- `navigate(path)`：通过前端 history 切换路由，并派发导航事件。
- `waitForTestId(testId, options)`：等待指定 `data-testid` 出现。
- `queryTestIds(prefix)`：列出当前页面中的 `data-testid`，可按前缀过滤。
- `setAuthToken(token)`：写入真实认证 token。
- `clearAuthToken()`：清除认证 token。
- `clearStorage()`：清空本地认证和浏览器存储。

桌面端 E2E 构建会额外注入 `VITE_WEWORK_DESKTOP_E2E_CONTROL_URL`。只有在 E2E 模式且该 URL 存在时，前端才会轮询本机 loopback 控制器来执行 `click`、`fill` 和等待断言；常规开发和生产构建不会包含控制端点。控制器只驱动真实 WebView DOM 事件，不替换任务、模型选择、Executor 或 Codex 的实现。

公共控制器在内置动作未处理命令时，通过 `@extensions/desktop-control` 委派给产品扩展。没有产品扩展时，未知动作会明确失败；公共自动化层不识别具体产品协议。

控制器使用短轮询：没有待执行指令时服务端返回 `204`，前端短暂等待后再次请求。这避免了 WebView 刷新、任务切换或流结束时遗留的长轮询连接吞掉后续指令。对 Lexical 编辑器执行 `fill` 时，控制器会使用编辑器暴露的 `value` setter，以便真实提交 React/Lexical 状态；不要用原始 DOM 插入来替代它。失败诊断中的 `scenario-state.json` 会记录已投递的 `commandHistory`，用于定位控制通道问题。

桌面控制器通过 Electron `webContents.capturePage()` 获取原生 renderer 截图。该能力只在 `VITE_WEWORK_E2E=true` 时开放；选择器截图按元素边界裁剪原生图像，因此诊断会保留真实 Electron 渲染结果。

同一会话在模型切换后可能触发 Codex 的内部上下文压缩请求。桌面端任务流 E2E 的 loopback Responses 服务会通过 `client_metadata.x-codex-turn-metadata.request_kind === "compaction"` 识别并响应这类请求，使它不被误判为用户发送的后续消息。

## 测试封装

`wework/e2e/fixtures/wework-app.ts` 提供 `WeworkApp` Playwright helper，用于把 `window.__WEWORK_E2E__` 封装成类型安全的测试操作：

```ts
const app = new WeworkApp(page);

await app.goto("/");
await app.waitForTestId("login-form");
await app.navigate("/apps");
const route = await app.route();
```

新增 E2E 用例应优先使用该 helper 和 `data-testid` 定位，不要依赖易变的 CSS 选择器或可见文案。

## CI 建议

平台 E2E 基础镜像 `docker/wework-e2e/browser.Dockerfile` 通过 `docker.io` 预装 Docker CLI，并在构建时执行 `docker --version`。各分片准备远程工作区 Executor 时直接使用镜像内的 CLI，不再运行 apt 更新和安装。Dockerfile 的内容哈希决定镜像标签，修改后 CI 会构建新镜像并在后续运行中复用。

本地列表启动读取和手动刷新共享同一版本号。启动读取若已被后续刷新取代，必须在写入列表和发起云端同步之前一并退出，避免过期启动请求重新开启同步并覆盖已选择的本地项目。原任务发现 E2E 的执行模式和本地运行断言保持不变。

云端 Issue 变化通知必须使正在读取的旧看板快照失效，并发起通知后的读取。使用共享控制器的 `loadProjectSnapshot(projectId, { invalidate: true })` 复用既有变更版本保护，避免连续取消指派、重新指派时，第二条通知复用第一条通知的旧请求。普通重复读取仍可合并。控制器的并发回归由 Frontend CI 执行，原人工 Issue E2E 保留 10 秒 UI 等待。

平台 E2E 的 service 顺序必须先启动 etcd 和 MinIO，再启动 Milvus。GitHub runner 按配置顺序逐一拉取并启动容器；如果将 MinIO 放在 Milvus 后面，后续镜像拉取可能让 Milvus 在依赖 DNS 尚不存在时初始化并退出。健康检查在全部容器启动后才执行，不能修复这一启动顺序问题。

桌面 E2E 的 `clickWhenEnabled` 会开启既有的 10 秒对话布局诊断窗口。阶段产物和失败产物保留 `conversation-diagnostics` JSON，记录虚拟列表范围、消息测量和滚动位置；诊断不包含消息正文，也不改变 UI 等待或业务断言。定位“消息状态已完成但正文未显示”时，应同时核对这些布局记录与 `workbench-debug.json`。

Windows 上工作树的 `.git` 文件可能带隐藏属性，Node 默认的 `writeFile` 写入模式会返回 `EPERM`。归档清理 fixture 使用 `r+` 打开已有文件、显式截断并写入，在 `finally` 关闭句柄；损坏、恢复和失败清理共享同一逻辑。

连续发送场景应同时核对请求计数和 composer 诊断：前一轮发送异步返回时，不能再次清空之后写入的新草稿。pane 通过输入写入版本约束提交清理；输入框已清空或用户已输入下一轮内容后，旧提交不再拥有当前草稿。异步接受与新草稿写入交错的单测必须覆盖带代码评论和普通消息两条发送路径。

桌面控制通道在模型 fixture 初始化结束后注册，初始化失败时也保留诊断入口。Workbench Home 迁移探针通过 `ensureLocalModelCatalogReady` 等待模型目录同步及其触发的 app-server 重启完成，再使用原生 Codex 访问迁移后的 Home。仅等待 executor 启动不代表目录同步已完成。原生探针失败时保留 `native-migration-turn-failure.json`，包含实际 Home、数据库完整性和线程历史模式；应先检查初始化警告，避免把日志库打开失败引起的 `list_turns` 错误误判为历史丢失。

打开项目设置时，直接等待并点击当前项目的编辑或重命名入口。侧栏根据项目的状态所属设备和来源选择菜单标识，不能根据菜单尚未渲染时的即时快照猜选入口。云端项目保存、重启和设置恢复断言保持不变。

macOS 本地验证云端项目状态文件时，运行中的 ChatGPT 或 Codex 桌面应用会触发既有的状态写入保护。在 HOME 和 Codex Home 均位于独立测试结果目录的 runner 中，可用 `WEGENT_FORCE_CODEX_GLOBAL_STATE_OPLOG_FLUSH=1` 验证状态实际落盘。

CI 可以把 Wework E2E 作为独立 job：

```bash
pnpm install --frozen-lockfile
pnpm --filter wework exec playwright install chromium
pnpm --filter wework e2e
```

桌面端全链路 E2E 需要在有图形会话的 Linux runner 上运行，例如：

```bash
pnpm --filter wework prepare:codex
xvfb-run -a pnpm --filter wework e2e:desktop:plugins
xvfb-run -a pnpm --filter wework e2e:desktop
xvfb-run -a pnpm --filter wework e2e:desktop:cloud
```

GitHub Actions 将 plugins、core 和 cloud 三个 Linux 桌面场景作为矩阵并行运行。
每个场景使用独立 runner、HOME、Executor Home、端口和诊断 artifact，保留原有
真实 Electron、Executor 与 Codex 验证语义，同时避免三个场景在同一个 job 中串行等待。
矩阵关闭 fail-fast，使一个场景失败时其他场景仍能完成并上传各自诊断。
三类场景复用同一个预构建 Electron artifact。Codex Home 初始化、云端地址和测试
凭据等场景差异由 Electron 启动时注入的 desktop E2E runtime config 控制，不再
编译进应用二进制；因此 plugins、core 和 cloud 可共享应用构建，同时仍保持各自
独立的运行目录与进程状态。

Linux 桌面场景会把 Electron 系统依赖下载得到的 `.deb` 文件缓存在 runner 用户目录，
并按操作系统、CPU 架构和自然周轮换缓存。每次运行仍执行 `apt-get update`，旧缓存
只作为恢复来源，缺失或更新后的软件包会从 Ubuntu 软件源下载。安装使用
`--no-install-recommends`，并为软件源请求设置重试和超时，降低托管 runner 镜像源
抖动导致整个桌面 E2E job 超时的概率。

内存门禁依赖 macOS 的 Electron 进程关联和 physical footprint 采样，必须在 macOS runner 上单独运行：

```bash
pnpm --filter wework prepare:codex
pnpm --filter wework e2e:desktop:memory
```

仓库内的基础 workflow 是 `.github/workflows/wework-e2e.yml`，会在 Wework、`packages/chat-core`、pnpm lockfile 或 workflow 自身变化时运行。
Linux 与 Windows Desktop Core E2E 共享分类器输出的同一份分片矩阵；完整分类会在
两个平台分别运行分类器定义的全部 Core 分片。Windows job 使用 `windows-latest` 构建
原生 `WeWork.exe`、`wegent-executor.exe` 和 `codex.exe` 后再执行 checkpoint，
不能用跨平台构建产物或单个 Windows smoke test 替代。

普通 Draft PR 不运行浏览器或桌面 E2E。merge queue 会在提交进入 `main` 之前运行
完整浏览器以及 Linux、Windows 桌面 Core 套件；`main` 不再重复运行已经通过的
合并队列检查。macOS 内存门禁仅在带有 `ci:memory` 或 `ci:all` 标签的非 Draft PR 中运行；
普通 PR、定时任务和手动任务均不运行内存 E2E。
workflow 每天 UTC 04:00 运行一次回归（不含内存 E2E）。添加 `ci:all` 标签则会运行浏览器、
Linux 与 Windows 桌面以及 macOS 内存 E2E，即使 PR 的改动路径通常不会触发
Wework E2E。

登录后流程应在测试前通过后端 API 创建测试用户和测试数据，再使用真实登录或真实 token 注入。不要在 Playwright 中 mock 后端 HTTP 响应。

### 本地项目场景的就绪条件

`voice-input` 首次进入和重启后均通过 `clickWhenEnabled` 等待“新建任务”挂载后点击。控制通道与遥测弹窗就绪不代表侧栏已完成挂载；保留共享 10 秒动作预算和语音首次配置、关闭弹窗及重启后的完整断言。

xterm 无障碍行先统一更新内容，再批量清除缩放、测量宽度及设置缩放，避免逐行写入和测量造成强制布局。依赖补丁同时覆盖源码、CommonJS 与 ESM；回归使用真实 xterm 验证第一次测量前所有行内容已更新。`background-terminals` 保留原生翻页、历史及无障碍断言，CPU 采样可用于核对布局热点。

转录转换中的 `runtimeStatus` 必须与当前消息的 `status` 一同更新，不能残留同轮用户消息的已完成状态并覆盖正在运行的 assistant。智能工作台验证按阶段记录开始、完成与耗时，不记录环境变量或凭据；阶段卡住时先从日志定位，不能靠延长 E2E 等待来处理。

智能工作台验证通过 `NPM_CONFIG_WORKSPACE_DIR` 将 pnpm 限定到项目自身，并关闭运行脚本前的隐式依赖安装。类型检查、测试、构建与运行时探针照常执行；不能为验证而读取或安装包含该项目的宿主工作区。真实 pnpm 回归覆盖宿主版本冲突以及宿主锁文件不被创建。

桌面构建产物使用 `actions/download-artifact@v6` 恢复，包含下载流超时后拒绝等待 Promise 的上游修复，避免进程成功退出却留下不完整目录。参见 [artifact SDK 超时修复](https://github.com/actions/toolkit/commit/523ce8ccda300661be06e592b615399fcfc282dc)。Windows 网络失败诊断保留连接状态、动态与排除端口范围、套接字耗尽事件和内存池计数，不采集进程命令行或凭据。

分身完成状态可能先于运行时未读标志到达。观察开始后的新完成必须保留为未读，并从当前已读账本决定投递，不能将它当作历史恢复提前消耗。投递记录按批次持久化后再发送通知；回归覆盖迟到的未读标志、重载不重放及 1000 条记录只写一次投递账本。

`createSingleRootLocalProject` 必须等待新项目成为 workbench 当前项目，不能只以创建弹窗消失或旧输入框仍可见作为就绪条件。云端上下文与运行历史场景还要通过 `selectE2EModel` 明确选择已注册的模型，再输入首条消息；其上下文阻塞、附件、历史恢复与任务移动断言保持完整。

运行历史场景的 3 秒响应性门禁使用工作台快照，不将 `performanceSnapshot` 内强制 GC 的调试协议耗时算作 UI 阻塞；完整历史、分页、传输与内存断言仍保留。Windows 重启检查保持旧执行器必须退出的断言，并记录指定 PID 的进程名与启动时间，以及 `taskkill` 的退出码和输出，以区分未退出的执行器与复用的 PID；不采集进程命令行或环境变量。

分块历史传输以压缩内容哈希命名不可变快照。并发请求通过不覆盖的原子发布复用同一文件，避免替换 Windows 正在读取的快照。回归验证已发布文件及其修改时间保持不变、活跃读者不受影响，以及四个并发请求均可完整还原原历史；原运行历史 E2E 不变。

Windows 重启门禁按 PID、进程名和创建时间核对进程实例，而不是在新应用启动后仅按旧 PID 判断。PID 相同但创建时间不同属于新实例；原实例仍存活时必须失败，身份查询失败或缺失创建时间同样失败。保留原模型代理重建、会话恢复和续写断言，以及原 UI 超时。参见 [Windows 进程句柄与标识](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers)。

检查点任务沿用现有 30 秒模型请求预算，收到请求后才开始原有 10 秒 UI 完成断言；模型启动耗时不计入渲染预算。提交与请求观察共同等待，输入失败后观察器超时也不会成为未处理异常，原始错误仍进入正常诊断和清理。

云端模型请求超时并取消后，通过真实模型选择器的打开动作显式刷新目录，再关闭菜单以便恢复阶段重新打开。本地模型设置变更事件只刷新本地目录，不能用重复派发该事件替代云端刷新。云端失败、恢复、模型来源与插件断言保持完整。

空白对话提交完成时，复用当前任务身份检查，仅在创建的任务仍被选中时消费原草稿编号。用户返回新对话后输入的草稿不能被旧请求迟到的完成回调清空；创建被拒绝时仍恢复原草稿与附件。延迟创建与延迟刷新的回归测试覆盖这两个窗口，原 9 条任务批量完成与归档 E2E 保持不变。
