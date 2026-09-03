---
sidebar_position: 33
---

# 性能诊断

Wework 内置一个默认关闭的前端性能诊断开关，用于定位 release 包中“运行一段时间后变卡”的问题。诊断代码只在显式开启后运行；关闭时不会安装 React Profiler，也不会采集定时样本。

## 多实例调试

使用 `pnpm --filter wework dev:mac` 启动日常 debug 应用时，默认直接使用正式版的 Executor Home，因此项目和任务会与本机正式版 Wework 共享；每个 Wework 进程仍通过自己子进程的 stdio 与 executor 通信，不会发生端点覆盖或误连其他 executor。需要临时隔离项目和任务时，使用 `pnpm --filter wework dev:mac -- --executor-isolation`。

`ai:verify` 和桌面 E2E 不使用上述共享默认值。它们会显式创建临时 Executor Home、项目目录、设备 ID 和唯一 Electron app-data namespace，使任务、项目、应用数据以及单实例锁都与正式版和其他验证会话隔离。

开发环境默认让这些实例复用同一个 Cargo target 目录，以便 executor 源码变化后继续使用增量编译产物。需要排查共享构建缓存问题时，可以设置 `WEGENT_DISABLE_SHARED_CARGO_TARGET=1`，让当前启动过程使用项目内的默认 target 目录。

## 启动耗时诊断

桌面端的启动页只等待本地 executor 通过 stdout 报告 ready；debug 构建不会为了播放完整动画而延迟工作台。冷启动时， Electron 直接启动新的 sidecar，不发现或附着已有 executor。

排查启动页长时间不消失时，对齐前端日志的 `Frontend logging initialized` 与 executor 日志的 `app IPC stdio ready`。两者之间的时间主要反映本地 executor 冷启动；`runtime work list finished` 等后续记录用于判断工作台数据加载耗时。不要把后台云端同步的超时误判为本地启动门控。

### 首屏门禁与闲时任务

工作台首屏只依赖本地 executor 可用，不等待 Codex app-server、插件市场同步或可清理目录扫描。需要 Codex 的功能会在用户实际使用时启动它；插件自动升级、内置插件市场准备和临时图片清理等维护工作通过统一的 renderer 闲时任务调度器执行。

闲时任务同时满足以下条件才会开始：

- 工作台首屏已经可用。
- 用户近期没有键盘、指针、触摸或滚轮操作，且 renderer 获得足够的 idle callback 时间片。
- Electron 主进程采样的系统 CPU、可用内存和系统空闲时间未达到压力阈值。

同一任务 ID 的待执行请求会合并，所有闲时任务串行启动。用户重新操作时，尚未开始的任务会延后；压力探测失败时也不会执行任务。调度器只决定何时开始，不允许任务在 renderer 主线程执行同步重活：文件扫描和复制必须进入 Executor 的 blocking 线程池，目录清理使用 Electron 主进程异步 I/O，网络同步保持异步。

内置插件市场在首屏后计算确定性的内容 SHA-256。目标目录中的 `.wework-content-sha256` 与当前内容一致时不再复制；内容变化时才通过 staging 目录替换，并把 hash 纳入 Codex 本地市场注册键。这样 Wework 升级后仍会及时刷新内置插件，而相同版本启动不会重复复制整个市场。

## Runtime 任务创建诊断

前端会将任务创建关键阶段以 `[Wework] Runtime task create diagnostic` 前缀写入持久化日志，无需开启性能诊断。记录只包含阶段、任务/设备标识、模型标识、耗时和结果，不包含消息正文、凭据或模型连接配置。

排查“乐观任务已显示，但 executor 没有收到 `runtime.tasks.create`”时，按以下顺序查找最后出现的阶段：

1. `workbench-model-prepare-*`：工作台发起并完成首次模型准备。
2. `workbench-runtime-create-dispatched`：工作台开始调用 runtime 创建接口。
3. `hybrid-local-device-discovery-*` 和 `hybrid-route-resolved`：混合服务完成设备发现并选定本地或云端路由。
4. `hybrid-create-forwarded`：创建请求已转发到选定的 runtime API。
5. `local-device-resolved`、`local-primary-model-prepared`、`local-supervisor-model-prepared` 和 `local-payload-built`：本地/远程 Executor IPC 客户端完成设备解析、模型准备和 payload 构建。
6. `local-rpc-dispatched` 与 `local-rpc-resolved`：`runtime.tasks.create` 已发出并返回。
7. `hybrid-create-resolved` 或 `hybrid-create-failed`：混合服务观察到最终结果。

缺少下一个阶段通常表示调用停在两条记录之间。结合相同 `taskId` 对齐前端日志、云端 WebSocket RPC 日志和 executor 日志，确认是模型同步、设备发现、payload 构建、IPC 发送还是 executor 响应卡住。

## 开启方式

在 Wework 窗口中按隐藏快捷键：

```text
macOS: Cmd + Option + Shift + P
Windows/Linux: Ctrl + Alt + Shift + P
```

快捷键会打开 **Developer Commands** 菜单。选择 **Enable Performance Diagnostics** 会写入 `localStorage` 中的 `wework:perf-debug` 标记并自动刷新应用；再次打开菜单选择 **Disable Performance Diagnostics** 会关闭诊断并刷新。

开发环境也可以通过 URL 参数临时切换：

```text
?weworkPerf=1  # 开启
?weworkPerf=0  # 关闭
```

也可以设置构建/运行环境变量 `VITE_WEWORK_PERF_DEBUG=1`，用于本地复现时默认开启。

## Debug 面板

Developer Commands 菜单中的 **Debug Panel** 用于排查 Wework 当前运行任务的问题。面板会展示：

- 当前活跃 runtime task 的地址、任务是否可识别、`running` 原始值、任务状态和 pane 派生运行状态。
- 当前 pane 的发送阶段、消息数量、队列、transcript 加载状态、subagent 状态和 goal 状态。
- Transcript 加载消息与当前流式输出消息的字段和预期 UI 样式对比。
- 最近的 `console.debug` 日志。

Debug 面板可以展开、收起、刷新、复制快照和清空日志。收起后只保留右下角状态条，避免遮挡主界面。

### Runtime 内存快照

Debug 面板的快照会附带当前 runtime pane 的轻量内存摘要，用于定位 WebView 或 executor 内存异常：

- 消息数量、角色分布、状态分布和正文长度汇总。
- processing block 数量、类型分布和工具输出长度汇总。
- 队列消息、guidance 消息、代码评论上下文和 transcript 范围状态。
- 当前 runtime task 在 work list 中的 `running` 原始值，以及由 pane 推导出的运行状态。

快照只记录摘要，不会把完整命令输出、原始 Codex 事件或完整 transcript 内容复制到 Debug 面板。需要排查原始内容时应查看 executor 日志或 DevTools 采样，而不是通过前端快照搬运大文本。

## Runtime transcript 与列表载荷

为降低前端和 executor 的内存压力，runtime task 列表、runtime handle 摘要和 transcript 响应只保留 UI 必需字段。命令输出、streaming delta、cached message、原始请求/响应等大块原始载荷不会放进 runtime work list 发送给前端。

前端显示对话时仍以 transcript/message action 生成的 `WorkbenchMessage` 为准；任务列表和状态轮询只用于状态、标题、运行态和 workspace 信息。排查“列表很慢”或“切换任务内存上涨”时，应优先确认是否又把原始消息或命令输出加入了 runtime list/handle/transcript 元数据路径。

Codex 0.147 的历史读取必须遵循线程持久化时确定的 `historyMode`。Executor 先通过 `thread/read(includeTurns: false)` 读取元数据：`paginated` 线程使用 `thread/turns/list(itemsView: notLoaded)`，再通过 `thread/items/list` 加载每个 turn 的完整 item；`legacy` 线程则直接使用 `thread/turns/list(itemsView: full)`。旧 rollout store 不支持 `thread/items/list`，因此不能仅根据 Codex 版本强制走 item 分页。

Codex 会从历史 API 中过滤 `<codex_internal_context>`，因此 Wework 发送目标或续接请求时必须按 `clientUserMessageId` 保留可见用户内容，并在加载 transcript 时与 provider item 合并。对于升级前没有本地 presentation 的 `legacy` 会话，仅当最旧页的首个 turn 完全没有用户消息时，才使用 thread preview 恢复首条需求；首个 turn 已包含文字、图片或附件消息时不得重复补写 preview。

### Pane 缓存与资源生命周期

桌面工作台最多缓存 10 个普通 pane，并按最近使用顺序淘汰。非活跃且已停止运行的 pane 会释放 transcript 消息、历史 DOM、分页范围、导航索引和 processing 展开状态；再次切回时从 runtime transcript 原始数据重新加载。

Electron 对话统一使用 `@tanstack/react-virtual` 的消息行虚拟列表，不再根据消息数量切换实现。用户停留在底部时，虚拟列表使用 `anchorTo: 'end'` 维持末端跟随；用户主动向上滚动后必须切换为 `anchorTo: 'start'`，避免流式消息行增长时 TanStack Virtual 继续改写滚动位置。滚动快照统一表示为“视口底部到列表底部的距离”。库内共享 `ResizeObserver` 测量已挂载消息的真实高度。活动中的流式消息即使位于可见范围和 overscan 之外，也必须保留在虚拟 range 中，使其高度增长持续进入 TanStack Virtual 的测量；否则消息重新挂载时从估算高度切换到真实高度，会破坏历史阅读位置。用户停留在底部时，高度变化继续按末端距离补偿；用户主动向上滚动后，则记录视口内首个文本滚动锚点及其视口偏移，并在流式消息重新测量时恢复该文本锚点。这样既能保持底部自动跟随，也能避免正在阅读的文本随流式输出持续向上漂移。渲染范围在可见区前后各保留 2 条消息。消息行不再使用 `IntersectionObserver` 做第二层窗口化；单条超长 Markdown 仍保留独立的块级窗口化，以限制一个可见消息内部的 DOM 数量。未挂载富文本的块保留轻量纯文本内容，避免快速滚动时出现只有高度、没有可绘制内容的空白区。其余 `IntersectionObserver` 用途包括跟随底部状态和附件预览等独立功能。

桌面对话滚动容器使用 DOM 底部原点：位于最新消息时 `scrollTop` 为 `0`，向历史方向滚动时为负值。业务状态、滚动快照、轮次导航和 E2E 断言只使用“距底部距离”或内容坐标，不得直接依赖顶部原点 `scrollTop`。TanStack Virtual 内部仍使用顶部 offset，但这层转换必须集中在 `useBottomOriginVirtualizer`，业务组件不得自行换算顶部坐标。切换任务时，hook 在同一次 layout commit 中按新 `conversationKey` 写入底部距离，避免先渲染顶部位置再在下一帧纠正。

非分屏工作台由 pane 栈父容器持有共享内容宽度，并把稳定值传给新任务 Pane；Pane 自身测量只作为首次启动、零宽测量和分屏模式的回退。环境信息栏是否停靠必须在新 Pane 的首帧使用这份共享宽度决定，不能先按宽度 `0` 渲染全宽聊天区，再在下一帧扣除 320px 侧栏，否则消息和 Composer 会出现一次横向闪动。

单条 assistant 消息可能包含大量工具块，并被拆成多个 `ToolBlocksDisplay` 段。依赖完整消息上下文的派生数据（例如文件编辑耗时）必须在消息级别只计算一次，再映射到各显示段；不得让每个显示段重复扫描整条消息。没有对应展示块时应直接走空结果快路径，工具名称匹配也应避免为每个 block 创建拆分数组或集合。

每个对话只缓存有界的 TanStack 测量快照，并与距底部滚动快照一起恢复。修改这套逻辑时，应覆盖短对话、长对话、底部流式跟随、屏幕外流式消息持续测量、向上滚动后的文本锚点稳定性、历史位置恢复、切换后重开、导航强制挂载和归档缓存淘汰。

Terminal 和内置浏览器属于有状态活动资源，不跟随普通 pane 淘汰。只要 pane 中仍有 Terminal 或浏览器标签，它就保持挂载，以保留终端进程和网页会话；关闭对应资源后，该 pane 才重新受普通缓存上限约束。修改这条边界时，必须同时覆盖普通 pane 的 LRU 淘汰、资源 pane 保活、消息行虚拟化和桌面内存 E2E。

## 本地 Codex 流式日志

本地 executor 的 Codex 调试日志默认保留 delta 详情，便于定位流式输出顺序、阶段识别和最终内容覆盖问题。默认会记录 Codex 原始 delta 与运行态分类摘要。

Developer Commands 菜单中的 **Enable Stream Logs** / **Disable Stream Logs** 会同时切换前端本地 chat stream 日志和 Codex executor stream 日志。优先使用这个菜单项做现场排查；它会让前端 `console.debug` 中的 stream 订阅/事件日志与 executor 的 Codex stream 详情保持同一个开关状态。

为避免 debug 包在长回复或高频 token 输出时产生过多日志，runtime work 内部的 cache/emit mapping 日志默认关闭。这类日志会为同一个 delta 额外记录缓存和 UI 事件分发路径，只有排查本地 runtime work 路由时才需要打开。

可用环境变量：

```text
WEGENT_CODEX_STREAM_DEBUG=0          # 关闭 Codex 原始 delta / 分类详情
WEGENT_CODEX_STREAM_DEBUG=1          # 开启 Codex 原始 delta / 分类详情（默认）
WEGENT_CODEX_STREAM_MAPPING_DEBUG=1  # 开启 runtime work cache/emit mapping 详情
```

## 流式消息渲染

Wework 将 executor 高频到达的文本增量与 Markdown 展示节奏分离。消息状态仍实时接收并保持完整内容，`AssistantMarkdown` 使用轻量缓冲器在浏览器帧上逐步推进可见文本：积压较多时自适应加速，接近队尾时保留少量字符并缓慢释放，以平滑 executor 批量发送和短暂空档造成的视觉顿挫。流结束、内容被替换或发生非追加更新时会立即对齐完整文本，不会影响最终消息正确性。

过程文本、thinking 和 plan block 的实时更新只传输 `content_delta`，不能在每个 delta 或完成节点重复发送从开头累计的完整 `content`。完成节点通常只携带 `status: done`；若 provider 的完成快照仅比已流式内容多一个尾部，则只补发该尾部增量。Wework 在浏览器动画帧内合并同一 block 的连续增量后再更新 React 状态，避免长程任务形成二次方级别的 IPC 复制和渲染压力。流式 block 更新属于可丢弃的 bulk 事件；发生 app IPC 背压时，终态事件仍保持优先，并由 transcript 对账恢复权威内容。Electron 主进程不得为每个 `response.*` 增量写 stdout；终端或父进程未及时消费输出时，同步 console 写入会阻塞 Browser 主线程和全部窗口输入。

流式消息不执行 Pretext 全文高度测量，而是使用稳定的离屏占位高度；消息完成后再精确测量并缓存。已完成消息优先按消息对象和宽度命中高度缓存，避免每次流式更新都重新计算历史消息全文 hash。Composer、Workspace 操作栏、右侧工作区和底部终端也使用稳定属性与 memo 边界，避免随每个文本增量重复渲染。

拖动底部终端面板调整高度时，高度更新按浏览器动画帧合并，并在拖动期间关闭高度过渡，避免高频指针事件触发过量 React 更新和终端重排。松开指针时必须提交最终高度，并恢复面板打开、关闭所需的过渡效果。

排查流式卡顿时应区分以下情况：

- 帧率稳定但输出一阵快、一阵慢：检查 stream `message` 事件间隔，通常是 executor 增量批量到达或存在网络/IPC 空档。
- 存在长帧、密集样式重算或 Markdown 解析：检查是否绕过了文本缓冲、破坏了 Streamdown 组件引用稳定性，或重新引入了逐字符 DOM 动画。
- GC 时间异常高：确认 DevTools 是否开启 **Heap Allocations**。该采集项会显著放大长时间录制中的 GC；只排查交互流畅度时应关闭它。

流式文本缓冲的单元测试位于 `wework/src/components/chat/useBufferedStreamingText.test.ts`。修改缓冲水位或推进速率时，应同时验证 Unicode 字符边界、非追加更新和流结束立即对齐行为。

## 常驻动画渲染

状态旋转图标和文字扫光属于常驻动画：即使页面没有输入或流式消息，它们也可能持续驱动 Web Content 进程。实现这类效果时，应保持每帧只更新可合成的 `transform` 或 `opacity`，避免动画化 `background-position`、`mask-position` 等需要重新绘制的属性，也不要直接旋转带有复杂描边的 SVG。

旋转图标应把静态 SVG 放在固定尺寸的 HTML 包装层中，由包装层执行 `transform` 动画并声明 `will-change: transform`。文字扫光应使用固定位置的高亮层，通过分段且错峰的 `opacity` 动画形成从左到右的扫光；基础文字始终正常渲染。两类实现都必须保留 `prefers-reduced-motion` 行为。

不能仅凭 CSS 属性名称判断动画是否进入合成线程。`will-change` 只是提示，`clip-path` 等看似可合成的属性在实际 Electron 版本中仍可能每帧触发主线程工作。修改常驻动画后，应在同一 Electron 版本、相同元素数量和相同窗口状态下分别录制至少 10 秒的旧实现与新实现，并验证：

- 暂停动画后 CPU 明显下降，以证明动画与占用存在因果关系。
- 新实现不再随帧产生 `Paint` 或 `PaintImage`。
- `UpdateLayoutTree` 和 `Layerize` 的事件数量与总耗时不再随动画帧持续增长。
- 动画方向、周期、颜色、尺寸和可见状态与修改前一致。

如果新实现仍持续产生绘制或图层化事件，应继续修改实现，而不是以视觉上流畅或平均 CPU 偶尔下降作为验收依据。

## 采集内容

开启后，诊断模块会采集：

- 浏览器 Long Task。
- 事件循环延迟，超过 120ms 时记录。
- 每 5 秒一次的内存、DOM 节点数、resource 数量和可见性状态。
- React root commit 耗时，超过 24ms 时记录。
- 手动标记事件。

最近 300 条事件保存在内存中，并暴露在 `window.__WEWORK_PERF__` 上。诊断数据不会上传到服务端。

## 现场取证

release 包默认编译 Electron DevTools 能力，但主 WebView 默认保持不可检查状态，因此其 Chromium 原生右键菜单不包含 Inspect Element。按隐藏快捷键打开 **Developer Commands** 并选择 **Open DevTools** 时，原生侧才会动态设置 `webContents.openDevTools()` 并打开 Inspector；该入口与 Performance Diagnostics 开关相互独立，要求 macOS 13.3 或更高版本。内置浏览器子 WebView 只在 debug 构建中启用 Inspector；macOS 会在 Inspector frontend 首次显示前强制 detach，因此 F12 打开独立窗口，不会停靠、重置子视图尺寸或覆盖工作台。release 构建通过显式 build cfg 禁用子 WebView Inspector。需要构建不含主 WebView Inspector 能力的发行包时，设置 `WEWORK_RELEASE_DEVTOOLS=0`。如需在本地诊断启动时自动打开主 WebView Inspector，可以用环境变量：

```bash
WEWORK_WEBVIEW_DEVTOOLS=1 /path/to/WeWork.app/Contents/MacOS/WeWork
```

DevTools 打开后，在卡顿后执行：

```js
window.__WEWORK_PERF__.snapshot();
```

返回值包含当前 URL、页面可见性、DOM 节点数、内存快照、导航时序、resource 数量、最近事件，以及 Wework 进程组快照。macOS 上 Chromium XPC 进程会被系统改挂到 PID 1；诊断会通过 LaunchServices 将当前 Wework 实例对应的 Web Content、GPU 和 Networking 进程重新关联进来。

进程组同时提供 `rss_kib` 和 `physical_footprint_kib`：RSS 包含共享映射和可回收驻留页，通常明显高于真实内存压力；判断泄漏或系统资源占用时应优先比较 `physical_footprint_kib`，RSS 只作为地址空间驻留的辅助指标。需要持续观察时可以多次执行，重点比较：

- `memory.usedJSHeapSize` 是否持续上涨。
- `processMemory.groups[].physical_footprint_kib` 是否在任务结束并冷却后仍持续上涨。
- 增长来自 `webkit-webcontent`、`codex-app-server`、`executor` 还是 `main`。
- `domNodeCount` 是否持续上涨。
- 是否存在密集 `longtask` 或 `event-loop-lag`。
- 是否存在重复的 `slow-react-commit`。

主工作台的全高侧栏和横跨内容区的顶部栏应使用普通语义背景，避免在大面积常驻表面应用 `backdrop-filter`。这类滤镜可能让 Chromium 为整个区域保留额外图形 backing store；排查 Web Content 内存时，应在相同窗口尺寸和页面状态下比较启用前后的 `physical_footprint_kib`，并把 DevTools 堆快照产生的短期可回收内存高水位排除在稳定基线之外。

也可以手动打点：

```js
window.__WEWORK_PERF__.mark("before-open-task", { taskId: "..." });
```

## 关闭方式

再次按隐藏快捷键打开 Developer Commands 菜单，然后选择 **Disable Performance Diagnostics** 会关闭诊断并刷新应用。也可以在控制台执行：

```js
localStorage.removeItem("wework:perf-debug");
location.reload();
```

关闭后 `window.__WEWORK_PERF__` 不再安装，React Profiler 也不会包裹应用根节点。
