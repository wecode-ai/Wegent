---
sidebar_position: 39
---

# AI 自验证会话

Wework 支持启动隔离的开发验证会话，让 AI 在真实 Electron 应用中完成 UI 操作和断言。该机制复用桌面端 E2E 的 WebView 控制通道，不会操作外部 Chrome，也不会连接开发者日常使用的 Wework 窗口。

## 桌面 E2E 错误采集与断言

桌面检查点统一使用真实 Backend、数据库和 MinIO；通过真实网络代理注入阻塞、断连及恢复，不生成假的 Backend 响应。模型服务可以使用协议替身。经明确授权，外部 Sites 和 GitHub/GitLab 协议（含 Git CLI 返回）也可以使用替身；贡献指南列明的钉钉外部协议测试同样遵循以下标记规则，不扩大允许替身的边界。Wework、Backend、插件发布/安装/激活和设备凭据同步仍为真实实现。相关检查点及报告标为“协议集成测试”，记录 `verificationType: protocol-integration`，并在 `externalServiceProtocols` 中列出 `sites`、`git-hosting` 或 `dingtalk`。共享钉钉 fixture 在准备时登记该协议，最终报告合并场景声明和实际使用的替身，不能覆盖已有登记。标记不代表真实外部服务兼容性已验证，也不允许替换其他服务。需要 Nevis 重启能力的扩展场景必须配置真实隔离服务。

共享 runner 从真实 `/api/users/me` 绑定检查点的用户身份及派生会话 ID，不保留旧假后端的固定用户编号。默认已连接场景通过真实授权会话建立原生桌面凭据，界面与 Host 使用相同 Backend 地址；登录场景显式从未连接状态开始。网络失败记录目标 origin、路径、请求 ID 和资源类型，排除 URL 用户信息与查询参数。 显式信息级诊断也通过独立协议写入同一日志；原始 warning/error 不会被降级，诊断格式错误会记录为采集协议失败。

公开 CI 的云设备重启用例使用独立进程控制器实际停止并重启同一沙箱的两个 Executor，保留 main 的重启授权、忙碌拒绝、离线与恢复验证。控制器不提供 Nevis 或指标协议的假响应；该用例验证真实进程生命周期，不代表 Nevis 服务兼容性已验证。

共享桌面 runner 在启动应用前创建 `errors.jsonl`，并通过 `control.errors` 和场景工厂参数 `errors` 提供查询与断言。记录不轮转、不截断堆栈，使用进程 PID、采集实例 ID、实例内递增序号、时间、来源、类型和严重程度关联错误；应用重启会创建新的实例 ID。日志在写入前复用现有脱敏规则。截图、日志及该记录均为测试产物，不提交仓库。

当前接入点与验证如下。表格描述已接入的边界，不代表任意代码路径都已经运行验证。

| 来源                   | 接入的错误出口                                                                                                                       | 聚焦验证                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 主进程                 | 启动日志、console warning/error、未捕获异常监视器（包含默认转成异常的 Promise rejection）                                            | `electron/src/host/e2e-error-sources.test.ts`                                            |
| 渲染器                 | 所有 WebContents 的 console warning/error、加载失败、进程退出；Wework 页面中的 window error、unhandledrejection、显式 `captureError` | `src/e2e/error-capture.test.ts`、`electron/src/host/e2e-error-sources.test.ts`           |
| 托管运行时             | RuntimeSupervisor 管理的 Core DSH／Executor 的完整 stdout、stderr、启动错误及异常退出                                                | `electron/src/host/e2e-error-sources.test.ts`（真实子进程）                              |
| 桌面驱动               | 原生驱动子进程输出、失败响应和连接失败                                                                                               | `electron/src/host/computer-use-driver-process.ts`；仍需真实桌面故障验证                 |
| Host 协议              | capability 失败响应和协议解析失败                                                                                                    | `electron/src/host/e2e-error-sources.test.ts`；capability 另由既有 HostPipe 单元测试覆盖 |
| 页面调用边界           | HTTP 客户端传输及失败响应、Host／Executor／Terminal 的业务失败（含 HTTP 200）、无效协议及连接失败、Executor／Terminal 事件流断开     | `src/e2e/error-boundaries.test.ts`、既有 transport 单元测试                              |
| 网络及 Electron 子进程 | Session 网络失败、HTTP 4xx/5xx、Electron 子进程异常退出                                                                              | `electron/src/host/e2e-network-errors.test.ts`；Electron 事件接线仍需真实桌面验证        |
| 采集本身               | 未启动、所需来源缺失、断序／重复、半条记录、序列化或写入失败                                                                         | `scripts/desktop-error-collector.test.mjs`、`electron/src/host/e2e-error-log.test.ts`    |

异步子进程通过 Node 原生 `child_process` diagnostics channel 自动登记生命周期，Node Worker 通过原生 worker 事件登记异常，使用 `errorMonitor` 观察而不接管原有错误处理。对应真实进程／线程验证位于 `electron/src/host/e2e-process-errors.test.ts`；桌面驱动边界另有 `computer-use-driver-process.test.ts`。不会为了采集而读取外部命令的管道；自有托管运行时和驱动的输出在原有消费点收集。Worker 只旁听已经消费的输出流，不改变其流模式；尚未消费、无法观察的流会记录完整性失败，不能认证为已完整采集。非零退出和信号终止保守记录为错误事实，主动终止的预期事件也应明确断言。

跨重启应在旧进程退出前确认其区间，随后在新进程中重新取 `mark()`。同一个断言区间包含不同采集实例时，异步认证会失败；当前进程的 checkpoint 不证明此前已退出进程的最后输出完整。

场景必须明确执行断言，runner 不自动把所有既有故障场景改成零错误场景。推荐 `assertCollectedErrors`：它通过隔离验证 IPC 向主进程请求落盘 checkpoint，核对累计写入失败次数、序号和已提交字节位置，检查截至该位置的稳定快照；即使最后一次写入失败且 stderr 丢失，也不能通过。`assertErrors`／`assertHealthy` 是本地记录检查，不能代替主进程确认。正常流程传空预期数组；故障流程应使用精确的来源、错误代码、类型和次数，并拒绝剩余错误：

```js
control.errors.assertHealthy({ sources: ["main", "renderer", "runtime"] });
const after = control.errors.mark();
// Perform the operation and wait for its observable result and error report.
await control.errors.assertCollectedErrors(
  control,
  [
    {
      description: "The executor reports the injected failure once",
      match: (event) =>
        event.source === "renderer" &&
        event.type === "executor:example.operation" &&
        event.details.code === "injected_failure",
      count: 1,
    },
  ],
  { after, source: "renderer", sources: ["main", "renderer", "runtime"] },
);
```

不传 `source` 或 `type` 才会检查所选时间段的全部错误；过滤仅证明指定边界。`query` 可以读取原始运行时输出。stdout 保留为信息，stderr 保守地视为错误，输出块不是业务错误条数，不能据其次数推导业务失败次数。warning 单独查询，不等同于 error。断言前需要等待实际错误报告到达，不能用固定延时作为采集完成的证据。

既有 `core-task-flow` checkpoint 新增采集自检：发出一条明确的 `collector-probe`，等待其真实记录，验证恰好一条，并通过原生 checkpoint 核对落盘。沿用现有 CI、构建和实例，不新增 E2E 作业。该故意产生的错误保留在日志中；后续操作用 `mark()` 划定区间，不配置全局忽略。新增 E2E 覆盖尚需实际运行后才构成真实 Electron 验证证据。

覆盖验收必须同时检查接入点、故障注入和真实桌面执行证据。进程／窗口出现过不证明其所有错误出口都被测试；静默吞掉的异常、没有上报的业务失败、独立 Web Worker、自定义 Session 中后来覆盖网络监听器的代码，以及强杀时未排空的最后输出，不能由此日志自动证明完整。进程停止或失联而无法确认 checkpoint 时，异步采集断言必须失败。历史包没有采集代码时，显式健康断言必须失败，不能将空记录视为没有错误。插件及外部服务只验证调用结果、连接及协议边界，不宣称覆盖其内部实现。新增这类出口必须接入报告并增加故障测试；完成这些验证前，不得宣称“自有进程全覆盖”或“零遗漏”。

CI 与共享 runner 复用同一个结果清理实现，依据检查点 owner 进程与桌面进程组的实际存活状态决定是否压缩结果目录；存活期间保留其工作目录、运行时和缓存，避免取消后仍执行的子进程因清理而产生文件缺失。进程停止后才清理可重建内容，保留诊断文件。强制取消仍可能中断最终确认或产物上传；缺少对应原始流、最终摘要或确认的报告不能认证为完整，不能因其数值报告标记完整就忽略缺口。

## 按操作统计界面更新

共享 runner 的 `control.refreshes`（场景工厂参数 `refreshes`）可以围住一个或多个操作，保存 `ui-refresh.jsonl`，并按区域设置更新预算。共享控制连接现在也会自动开启检查点采集；显式区间与自动区间复用一个 MutationObserver；多个区间可以重叠，结束时排空已排队记录，不使用固定等待猜测刷新完成。操作回调必须自行等待真实业务结果；若要验证后续一段时间没有额外刷新，继续使用既有框架的负向观察窗口。

指标必须分开解释：

- `renders`：已接入组件函数的调用次数，包括 StrictMode 重复调用及未提交的渲染尝试。默认接入 `app`、`workbench-provider`、`desktop-sidebar`、`desktop-workbench-main`、`workbench-conversation`、`right-workspace-panel`；同类组件的多个实例在当前渲染器内合计。可在更细的边界复用 `recordUiRender(id)`。
- 区域的 `mutationBatches`／`mutationRecords`：该 CSS 选择器覆盖范围内观察到的 DOM 写入批次／记录数，不是浏览器绘制帧数。批次包含 MutationObserver 回调及显式排空；嵌套区域分别统计，不能相加当作全局刷新次数。
- `rootRemovals`：匹配区域根节点被移除的次数；`maxAddedSubtreeElements`／`maxRemovedSubtreeElements` 是回调观察时新增／移除子树的最大元素规模，用于发现“一次更新就替换大片节点”。它们不是历史插入元素的精确累计值，也不代表像素重绘范围。
- `addedSubtreeElements`／`removedSubtreeElements` 累计回调观察时各新增／移除子树的元素规模，操作窗口可通过累计量差值衡量更新工作量：即使此前已有更大的替换，后续较小替换仍可观测并通过区域预算断言。替换区域外的共同父容器时，累计其中所有互不重叠的匹配根，嵌套匹配只计一次，峰值仍保留单个匹配子树规模。相同节点多次移动会重复计数；它们不是去重节点数、历史精确插入量或像素重绘面积。旧报告中缺少这两项时不可视为零；`max*` 仍表示整个采集窗口的最大值。
- `reactCommits`：复用 `wework-root` Profiler，保留快速提交的次数及 actualDuration 合计，不受原来慢提交阈值过滤。该范围为 App 的 Profiler 子树。以 `VITE_WEWORK_E2E=true` 构建的验证产物使用 React profiling 入口，记录真实提交次数；普通发布产物不启用该入口。对于未启用 profiling 的产物，未观察到有效回调时仍返回 `null`，不会用 DOM 批次冒充提交次数。

例如，已有测试中的 `operationAndWaitForResult` 可以包含多个操作及其业务等待。只有明确要求不影响侧栏的场景，才采用下例的零更新预算；其他预算应依据需求及实际测量制定，不设置通用猜测阈值。

```js
async function verifyLocalOperation(control, operationAndWaitForResult) {
  const result = await control.refreshes.measure(
    "local-panel-operation",
    {
      regions: [
        { name: "sidebar", selector: '[data-testid="desktop-sidebar"]' },
        {
          name: "conversation",
          selector: '[data-testid="desktop-workbench-pane-stack-container"]',
        },
      ],
      renderIds: ["desktop-sidebar", "desktop-workbench-main"],
    },
    operationAndWaitForResult,
  );

  control.refreshes.assertWithin(result, {
    regions: { sidebar: { mutationBatches: 0, rootRemovals: 0 } },
    renders: { "desktop-sidebar": 0 },
  });
  return result;
}
```

也可手动 `start(label, options)`／`stop(token)`，分别覆盖多个操作区间。使用稳定的产品 CSS 选择器；区域从未出现、组件没有接入计数、指标拼错或所需 Profiler 不可用，均不能按 0 通过预算断言。只有明确预期区域不存在时才设置该区域预算的 `allowAbsent: true`。标签使用固定操作名，不放入用户输入或凭据。结果仅保存标识、选择器及数值，不采集 DOM 文本或 HTML。

区间记录包含期间的后台更新，不证明更新全部由操作导致。采集绑定开始时的控制客户端，操作中切换窗口不会混入另一个窗口的计数；各窗口可以分别采集。原渲染器整页重载、退出或丢失采集状态会使结束失败，并保存 `complete: false`，不得返回零更新。DOM 指标仅覆盖当前文档的所选 DOM，不进入 iframe 或 Shadow DOM 内部，也不等同于像素重绘。操作失败仍尝试保存指标，并保留原始失败；采集也失败时一起报告。既有 `core-task-flow` 增加了真实 DOM 瞬时区域写入／移除自检，沿用原 CI 与实例；接入不等于已经运行真实 Electron 验证。

验证控制客户端连接期间，会话布局诊断使用独立租约持续采集，避免长操作越过普通 10 秒交互窗口后丢失上下文；客户端结束或注册失败都会归还租约。原有环形缓冲仍最多保留 400 条脱敏事件，并报告丢弃数量。ResizeObserver 错误快照同时附带这份已采集的滚动与布局记录，附加快照不读取 DOM。普通产品交互仍使用原有短时窗口。

## 逐检查点性能诊断

共享桌面控制通道自动在 ready／started／results 回执中携带累计指标，按 renderer capture ID 合并，保存为每个结果目录的 `performance.json`。CI 在原有桌面作业中生成逐检查点表格，并上传独立数值产物。当前阶段只采集、分析本次运行；不创建 main 基线、不比较历史总量，也不将“未发现增长”当作性能通过。报告明确记录 `baselineStatus: not-established` 和 `comparisonValidated: false`。

等待可见性条件失败时，共享控制器额外记录动画播放状态、pending 标记、有限数值时间及布尔 data 状态。只在失败后检查，最多扫描 128 个后代、输出 16 项状态和动画，并明确记录省略数量；API 缺失或读取失败为未知，不能当作零动画。不得记录文字、输入、关键帧或非布尔 data 值。这些诊断用于定位关闭状态与退出动画，不改变等待、关闭或渲染行为。

指标包含 DOM 写入记录、节点增删和最大子树规模、已接入组件的 render 次数、可用时的 React commit 次数，以及 Executor RPC、独立 describe 请求、事件类型、全量／待处理任务读取、连接重建及失败次数。显式 AbortSignal 取消独立计数；导航中的网络中止仍保留事实，不能自动认定为业务失败或忽略。重复事件到达和实际重复投递分别统计。解析和协议错误保留用于逐项调查，故障注入中的预期错误仍需显式区间断言。

`executor.parseFailures` 与 `executor.protocolFailures` 统计前端 Executor／DSH 传输层的响应体、事件解析及协议形状校验。它们为零不证明原生 Executor、Codex 或外部服务没有解析／协议错误；原生 JSON-RPC 错误、预测 JSON 拒绝和 HTTP 路由拒绝仍须从对应进程与请求边界日志核对。`executor.cancellations` 对应带已中止 AbortSignal 的明确本地取消；服务端返回的取消错误仍按实际错误响应记录，不能用同一错误代码下的首条消息概括全部记录。

`observations` 保留每个控制命令开始／回执时的非零计数增量、命令 ID 和动作名，以便区分操作期间与命令之间的后台工作。每个 capture 中计数器首次被观测时也保留零值，区分“已观测且无变化”和“未知”；区域稍后才可观测时，从首次有效快照开始记录，不能向前补零。旧产物缺失这些零值时仍保持未知，不能从跨 capture 的总数推断操作区间。该关联不证明因果关系。只保存类型名、标识和数值，不保存请求参数、事件正文或凭据。方法名相同也可能对应不同资源，不能直接视为重复请求。按需使用 `control.refreshes` 选择更细的区域和业务等待。

测量从控制连接建立持续到最后一次已接收回执；清理前补读活动客户端。接入之前的启动工作、关闭或重载窗口最后回执之后的工作不能由该性能窗口证明完整。缺失数据、计数重置和不可用指标必须标记为不完整，不能补零通过。E2E 验证构建启用 production profiling；普通发布产物的 React Profiler 不可用时，提交指标仍为 null。错误落盘完整性有独立契约。

建立基线前先分析相同操作的实际波动，区分启动、周期轮询、业务动作和生命周期终止。机器争用会改变耗时和轮询次数；组件 render、DOM 写入、绘制帧数必须分开解释。后续启用 main 基线仍需一次显式建立阶段，首份可信基线产生后强制门禁，不允许丢失产物时静默重新初始化。

Windows 调度使用已核验成功检查点的实际耗时，保留较大的历史成本和来源，删除分组展开后不再使用的别名权重。失败、截断和未观察项不能作为成功样本。只有完整 Core 范围的已知可移动成本超过原有进程容量，且增加一个共享 runner 后能够容纳这些成本时，才增加该 runner；部分范围、已经足够的容量和无法靠一个 runner 解决的超长单项均不扩容。两个独占分片、准备分组、未知成本所属分片和场景覆盖不变，不增加搜索、步骤或进程时限。进程容量配置由契约测试与原生 Windows 包装器的实际期限核对。未知成本继续显式报告，调度权重不是 main 性能基线或性能通过证明。

`coordination-history` 通过真实 SQLite、调度器和原生任务验证大量历史失败记录不会阻塞新任务，并验证后台保留清理。清理先在写事务之外按索引选取候选，再以零等待方式申请每批至多 25 条记录的写入准入；准入后核对引用并提交，避免其他 WAL 写入使只读快照升级失败。已有写入者仍使本次维护立即让行，WAL 读者保持可用。保留每轮 100ms 调度预算、至多四次提交及原有引用保护；预算不用于中断已开始的事务，也不延长 E2E 等待期限。

### 计数口径与故障定位

项目空间任务上下文查询通过 `project-space-task-context-lookup` 记录查询标识、数据源索引、起止结果、截止时仍未完成的来源及迟到结果。`project-space-task-context-failed` 保留已捕获失败的原因与堆栈，包括聚合异常的各个原因；原有警告仍独立保留。这些记录用于区分查询期限、源失败和迟到返回，只包含标识和诊断字段，不保存请求正文。

`observations` 保留采样墙钟时间和当前 renderer 的累计运行时间，`captures` 保留各 renderer 的起止时间，避免仅凭累计请求量判断频率。控制命令在 started 阶段计数一次，不将 started／result 两次回执算成两个操作。

子树移除按 `MutationRecord.target` 所属区域计数；移除后的节点已脱离 DOM，不能用当前 `contains` 判断其原始归属。每个操作窗口保留最近 32 条带测试标识的移除来源，每条至多 16 个标识及相对时间；共享日志按命令保存新增来源，不记录 DOM 文本或保留节点引用。

故障门主动回放的重复投递保留原始计数，并另记 `injectedDuplicateDeliveries`；只有未被真实故障注入上下文解释的重复投递才标记为不变量异常。该归因来自共享 transport gate，不配置场景名或错误忽略列表。普通网络重放到达后被去重丢弃的帧仍单独记录。

收到 ResizeObserver 循环错误时，E2E 错误记录附带最近 32 次原生 observer 回调的构造堆栈、回调名和最多四个目标的测试标识、标签及尺寸。同时记录每次回调内部的 DOM 写入数量，以及最多八个写入目标的标签、测试标识和属性名，以定位“测量后写布局”的循环来源。诊断不采集 DOM 文本或属性值，不增加布局读取，不改变回调时机或抑制异常；它是有界故障上下文，不证明所有历史 resize 回调完整。 另保留最近 32 批回调之间的 DOM 写入，覆盖延后提交；仅记录时间和最多八个目标，不将时间相邻解释为因果归属。

正常 transcript 取消通过实际 AbortSignal 及对应拒绝对象识别，各调用层保留取消和原始拒绝，避免重复记成故障；信号已取消时发生的其他错误仍必须报告。乐观任务打开时，goal 与项目关联读取等待同一个真实创建 Promise 持久化完成，已离开的视图取消自身读取，独立任务不受影响。新增 `runtime-task-readiness` 复用现有 Core CI，实际挂起创建请求，证明读者已到达屏障且尚未发出 RPC，释放后验证真实模型结果和 goal 响应，不使用固定等待证明就绪。

`errors-summary.json` 的 `assertions` 保存错误匹配断言的范围、成功／失败、预期数量和记录编号；仅经原生采集检查点确认的断言附带检查点身份与字节偏移。`assertionCoverage` 按 `level=error` 的记录去重统计已断言、原生确认以及未断言数量。重复断言不重复计算，失败断言不提供通过证据；摘要不复制错误内容或描述，不把一个范围的确认推广为全局无错。旧产物没有这些字段时，断言覆盖保持未知。

## 空闲 Executor 请求回归

`idle-executor-requests` 使用无任务、断开云端的隔离真实 Electron 和 Executor，复用共享 runner 的首次遥测拒绝流程，然后重新加载主窗口并观测请求。启动后的工作树能力发现、遥测配置和共享 SSE 订阅必须各一次；前台与关闭到后台各观察 6.5 秒，跨过 5 秒轮询周期，要求继续发现待处理交互并保留 Runtime 身份检查，禁止全量任务目录轮询和重复启动配置。异步插件等已知启动请求允许完成，不以固定延时推断启动完成。

缓存任务列表返回后的 Native 后台发现仍照常执行；仅在项目与任务的可见结果发生变化，或 Native 目录发现失败、分页未读完时发送工作变更通知。完整且无变化的同步不触发额外全量读取；目录覆盖不足时仍保留权威全量查询，不能将截断结果当作完整目录。

同一同步批次的身份描述读取只在尚未发出时共享；操作后的身份校验仍读取新的描述。已确认的本地 Runtime 遥测策略不随空闲轮询重写，Runtime、账户、API 或策略变化时重新同步，失败后重试。工作列表变更仅刷新任务数据，设备发现仍由设备事件和显式刷新负责。工作事件不会取消进行中的完整云端同步，而是合并为同步完成后的一次最新任务读取；bootstrap 的设备与团队同步也不会因任务读取版本变化而丢失。

遥测配置、列表与确认使用既有阻塞工作池执行同步 SQLite 操作，不能占用异步 RPC 分发线程等待写锁。聚焦回归持有另一个真实连接的写事务，验证配置请求首次轮询让出调度、同一期间读取仍可完成，并在释放写锁后成功保存；不改变同意策略、事务、数据库等待或 E2E 时限。

恢复最近项目必须等待本地工作列表结束初始加载；先到达的云端合成列表不能消耗这次恢复机会。设备或云端目录可独立发布，不能将其到达误判为本地项目已经就绪。

```bash
pnpm --filter wework e2e:desktop --segment idle-executor-requests
```

检查点注册在现有 Core CI 分片，独立运行不依赖前序场景。本地 macOS arm64 验证含启动与清理耗时约 52 秒，共享构建另计。结果目录的 `idle-executor-requests.json` 只保存方法名、时间、状态和必要布尔标志，不保存请求参数、头或查询字符串；日志和截图不得提交。

## 插件周期恢复 E2E

插件自动同步探测等待当前 Backend 配置提交确认，而不等待 Device／Socket 在线。共享连接状态分别记录配置就绪和连接状态；配置确认后，临时状态查询失败不抹去该确认。账号或 Backend 切换先清除就绪状态。`plugin-auto-update` 在业务流程前通过已确认的错误采集检查点断言启动期插件同步没有失败，避免把提前探测导致的错误当作正常启动。

`plugin-periodic-reconcile` checkpoint 使用真实 Electron、Executor、Socket.IO、数据库和插件包存储，丢弃一次真实插件变更通知后，验证定时对账恢复状态、持久化 ACK、设备身份以及未受影响插件的内容。测试实例设置 `LOCAL_PLUGIN_RECONCILE_INTERVAL=90`、`LOCAL_PLUGIN_RECONCILE_JITTER=18`（单位为秒），并用已有的 `LOCAL_HEARTBEAT_INTERVAL=1` 保留至少 10 次心跳的活性断言。检查点根据真实对账 tick 对齐故障注入；准备流程跨过某个 tick 时等待当前定时器窗口，而不是因负载延长周期。

未设置配置时，生产对账周期仍为 600 秒加 0～119 秒的稳定 Runtime 偏移，心跳仍为 30 秒。无效或非正整数配置使用默认值；测试没有手动触发对账或替换真实计时器。

```bash
pnpm --filter wework e2e:desktop:cloud -- --segment plugin-periodic-reconcile
```

插件账户迟到响应 E2E 由故障代理为指定响应添加唯一 `Server-Timing` 诊断标记，并保持真实上游响应正文原样。验证按标记确认渲染器实际消费旧响应，再检查当前账户清单持续稳定。浏览器可能为同一 HTTP 响应记录多个 fetch 消费者，不能以时间窗口内“恰好一条记录”代替响应身份。代理字节保持及重复消费者关联有协议测试，真实账户/设备边界仍由既有桌面 checkpoint 验证。

## 对话模型恢复诊断

选择「完整任务数据」后，反馈包的 `context/task.json` 包含 `modelSelection`。快照包含模型名称、类型、资源归属和诊断指纹。快照不包含任意模型参数和认证配置。

- `configured`：传入模型选择器的配置。
- `effective`：解析默认值后的配置。
- `selected`：输入框当前模型。

缺失记录保留为 `null`。`logs/app/model-loading.log` 的 `workbench.selection_restored`、`workbench.selection_changed` 和 `workbench.selection_seeded` 使用数字指纹关联模型和作用域。指纹只用于诊断。

完整工作台诊断快照还包含 `modelLoading`：当前渲染器最近 200 条启动／请求分段事件的副本，包含尚未达到 10 秒持久化刷新时机的事件。该有界窗口用于补充宿主日志，不能作为完整事件历史；窗口重载后重新开始。

执行器的 `runtime task model selection updated` 记录内存中的模型赋值。`runtime task get resolved link` 和 `runtime task transcript resolved link` 记录读取任务的模型身份。赋值日志不代表磁盘写入已经成功。

`configured` 不等于磁盘中的原始任务记录。对于现有对话，配置来自任务摘要或运行句柄。对于新对话，配置来自项目配置或用户偏好。

复现时按以下步骤收集证据：

1. 在重启前导出反馈包。
2. 重启应用。
3. 在首次发送前再次导出反馈包。
4. 核对执行器读取的模型身份。
5. 比较输入框的配置、有效值和选择值，区分模型记录缺失、默认值替代和输入框切换。

## 桌面 E2E 启动前准备

本地目录就绪使用共享 `ensureLocalModelCatalogReady` 控制命令，不以当前模型按钮的 `data-model-provider-id` 判定。该属性只描述当前本地 Codex provider；有效云端选择可以不带该属性，同时本地模型目录已经可用。目录去重、目标选项和协议行为仍分别断言，不因启动来源的先后替换有效模型选择。

Session 的网络失败记录补充 `sinceSendHeadersMs`（首次发送请求头至失败或 HTTP 完成）和 `responseHeadersAfterSendMs`（首次发送至收到响应头），均使用宿主单调时钟。未观察到的阶段为 `null`，不能解释为零耗时；这些值不包含发送前的排队时间，也不是服务端处理耗时。时序按 Session 和请求 ID 隔离，完成后释放；默认 Session 覆盖错误回调时仍须向共享记录函数传入该 Session。只保存时间和既有安全字段，不采集请求头、正文或查询凭据。

配置请求可能同时收到同一原生进程的 cloud-config 失败。每次 RPC 记录实际接收请求的 process generation；恢复在认证状态锁内核对该身份，只处理对应进程，或复用另一个请求已为同一进程完成的 Router 恢复。当前模式为 Router 本身不能授权重放；未知结果、无关 generation、显式官方订阅和独立 Home 均不复用该恢复。原有权限恢复与请求时限继续生效。子进程契约验证迟到失败复用既有恢复、只创建一次线程及上述拒绝边界，使用合成 Codex 协议服务，不证明真实官方 runtime 间歇缺陷已修复，真实 E2E 门禁仍保留。

共享控制器允许 Runtime 请求重叠，结果可能乱序到达。性能 journal 按同一 capture 的单调耗时插入每份快照，保留操作边界，并重新计算相邻增量与移除注记；不按网络到达顺序判定计数回退。来源客户端和起始时间必须保持一致，排序后真正回退或缺失的计数仍使采集不完整；相同耗时时保留到达顺序，不能据此消除不确定性。

累计快照发生计数回退、来源复用或字段缺失时，`performance.json.rejectedSnapshots` 保留拒收的操作边界、前后耗时及回退计数，帮助区分重置与乱序；报告继续标为不完整，拒收值不覆盖已确认指标。

桌面共享 runner 在关闭应用、控制器和服务以及结果清理完成后，才写入最终 `performance.json`。收尾断言或晚到的控制器错误使 `functionalPassed=false`，并保存 `failure.txt`；已有业务失败及其原始失败产物优先保留，写诊断失败不会把失败变为成功。模型请求与仅含数值／路由元数据的 HTTP 明细也在控制器关闭后统一写入 `model-requests.json`、`http-requests.json`，覆盖收尾期间到达的请求。共享 runner 在清理开始前统一保存一次模型、HTTP 与命令证据；该部分证据不生成成功的性能报告。`teardown.jsonl` 按阶段保存开始、完成或失败，记录日志排空前各日志的可读／可写流状态和缓冲字节数，不记录输出内容、命令参数或环境。异步资源诊断持续到最终收尾，清理卡住时不得把部分证据当成通过。指标完整性与业务结果仍分开判断。模型发现的既有阶段日志同时携带编译期调用文件／行号和 query ID，区分用户目录读取与内部队列、协调、对话创建等发起点，不增加请求参数或响应内容。

成功和失败场景均在收尾后写入 `command-history.json`，用命令 ID 关联指标观测与操作目标、renderer client、排队／送达／开始／完成时间及成功状态。仅保存固定字段白名单，排除输入值、期望文本、请求头和扩展 payload；失败场景的 `scenario-state.json` 不再重复保存完整命令对象。分析较大 DOM 替换时先关联操作和时序，不能仅凭相邻 `fill`／`click` 认定因果。

模型证据识别固定端点、带 base path 的版本化端点及 Responses compact；原有默认处理器范围不扩大。模型请求在进入场景处理器前登记，成功的自定义场景、审批评审、预测及默认模型路径都只记录一次；处理器等待、失败或收尾期间的请求不会因为尚未返回而遗漏。`model-requests.json` 的 `httpRequestIndex` 指向同目录 `http-requests.json` 的对应传输记录。持久化只保留请求体、场景、协议、关联索引和失败标记，不写 Authorization、请求头或扩展认证字段。

共享 DOM 等待超时时，错误诊断还记录检测次数、最后检测时间／匹配数量、总耗时和最大检测间隔；未进行检测时保留未知。最终快照出现控件并不证明它在期限内已可用，这些固定数值用于区分条件出现过晚与检测调度间隔，不能提高原等待期限、自动重试或把超时改为成功。

Windows 原生确认诊断进一步区分 UI Automation 程序集加载、窗口枚举开始／完成、所属窗口存在及标题匹配，各阶段只输出一次固定标记，不记录窗口文本。宿主在调用原生确认接口前记录仅含 action 的请求事件，与最终决定分开；该请求事件不证明操作系统已显示窗口。原有 PID／标题／按钮约束、10 秒查找与 12 秒进程期限保持不变，诊断不能使失败变为通过。

本地模型路由的线程归属拒绝记录路由 scope、请求线程／父线程、该路由绑定数量及其他匹配路由数量；缺失身份保持 unknown。预测 fork 绑定同时记录所选 scope、父线程是否已注册及是否采用准备路由，用于区分继承路由和后续重绑定。只在现有拒绝分支补充解析，正常请求不增加身份解析；不记录路由 token、认证信息或请求正文，不改变 409 拒绝或错误断言。

General Tests 的 Ubuntu 原生校验通过 `WEGENT_CI_APT_SOURCE_LIST` 显式选择 runner 现有的 `ubuntu.sources`，共享安装器对更新索引和安装使用同一来源范围，避免无关第三方仓库阻断 GDB 准备。系统软件源文件、发行版镜像地址和签名信任保持原样；所选文件不可读、索引更新或安装失败均阻断执行，并保留原错误码。该准备步骤不增加重试，不替代后续真实 Electron 校验。

Linux CI 的 GDB 崩溃诊断包装器在原有线程事件上，为每个实际子进程输出一次仅含调试器 PID 与 Executor PID 的身份记录。采集流的 `childPid` 表示管道所属调试器，原生 `executor_pid` 表示错误生产者；必须核对该关系，不能强行视为同一 PID。缺少关系证据保持未验证，不按 PID 接近或日志相邻推断。既有原生文件描述符探针同时验证唯一、有效且不同的两个 PID；退出结果和堆栈门禁不变。

插件批量写入在持有多份安装租约后，以 MySQL `NOWAIT` 确认全部目标父行可写；若任一行被其他事务占用，则回滚整个批次并释放所有租约，返回既有 `plugin_write_busy`，避免一个插件的数据库等待阻挡另一个插件安装。单插件协调、原子提交、父版本 CAS 与 ACK 代际栅栏保持不变，不延长等待或增加重试。现有真实 MySQL／Redis 并发集成套件覆盖拒绝、无关插件继续写入及解锁后恢复；桌面业务仍由原有 E2E 校验。

Windows 只读观察器在共享准备阶段将原有 C# 互操作源码编译一次，程序集文件名绑定源码 SHA-256。CI 将同一 DLL 随既有 E2E 客户端产物分发，各 checkpoint 校验后复用；本地共享 runner 在启动 checkpoint 前准备。4 秒观察操作仅加载程序集并枚举窗口，不再启动 C# 编译器。原有 1 分钟 Windows 前置校验、真实 Allow/Cancel 验证与错误门禁不变；准备失败或缺少匹配程序集会阻断执行，不回退动态编译。

Windows 共享确认客户端按 [微软 UI Automation 线程指南](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)显式使用 PowerShell `-Mta`，并在失败时保留实际 apartment 状态；只接受固定的 `MTA`／`STA`／`Unknown`，缺失或其他值保持未知。PowerShell 的默认 STA 不作为桌面自动化客户端的执行约定。正确对话框中观测到零个按钮，不等于按钮枚举阻塞，也不能单凭线程设置改变就认定真实 Windows 故障已修复。

个人插件列表和云端关联读取复用相同的市场根目录解析。尚未创建的市场不要求先写入目录或目录清单；仅缺失的关联注册文件表示空列表。独立保留的关联元数据仍须读取，损坏 JSON、权限错误、非目录根路径和符号链接继续失败，不清空或覆盖数据。

预测 JSON 解析失败保留字节数、JSON 错误类别和行列位置，完成事件包含来源与预测线程标识；不记录响应正文或解析器错误原文，不将无效 JSON 转换成成功的空建议。

预测 fork 保留当前原生进程已加载、且由 MCP App 会话保留的来源连接，即使该连接没有模型运行的配置缓存；不重配该来源，也不在 fork 后强制退订。App 专用来源纳入既有空闲 generation 跟踪，最后一个 App 会话释放后仍可按原策略清理。单独的 App 会话登记不能证明重启后的新进程已加载来源；重启后仍须恢复来源配置，临时预测线程继续清理。

既有 `mcp-apps` CI 检查点在 Executor 重启并恢复 App 连接后增加预测回归：确认恰好一次真实预测模型请求，再通过 App 调用检查 MCP 服务的进程实例身份不变，防止自动重建连接掩盖提前关闭。复用原有真实 MCP 服务、Electron、Executor 和检查点；只替代模型响应，不新增 runner，也不调整既有计数器断言。

原生 JSON-RPC 错误写入现有 stderr 和滚动日志，避免被 stdout/info 收集为普通输出；错误返回、脱敏和长度限制不变。既有 `core-task-flow` 采集探针追加只读 `config/read` 参数类型故障，要求官方 runtime 拒绝请求，且原生 `-32600` 诊断实际进入 stderr/error。探针按采集实例及子进程拼接完整日志行，不依赖系统分块数量；它只断言该故障存在，不确认相邻未知错误，不替代原有 renderer 的完整收集确认，也不证明全部 runtime 错误均已断言。聚焦子进程测试验证错误流和脱敏，真实端到端结果以 CI 为准。

Windows 原生确认框的共享客户端按 PID、`#32770` 对话框类及既有标题唯一匹配目标。CI 已观察到同一确认框的 UIA 后代树没有按钮，而 Win32 实际存在两个 Button 控件；因此统一改为枚举该对话框内同进程、可见且启用的 Button 句柄，再通过 UIA `FromHandle` 解析并使用原有 `InvokePattern` 完成真实点击。仍要求唯一匹配既有允许／取消名称；调用前重新验证 PID、父子关系、类、可见／启用状态、UIA 控件类型及名称，不使用鼠标坐标、按键或消息注入。Windows CI 另外用独立进程拥有的真实 OS 对话框验证允许和取消两种返回值，不替代 Wework 场景。原有 10 秒查找／12 秒输入期限不变。零按钮时保留一次只读 UIA 数量快照；任何输入失败（包括注册失败）另外启动最多 4 秒的只读 Win32 观察进程，按同一 PID、类及标题重新查找，只有唯一匹配才记录句柄、PID／类及子窗口／按钮数量。缺失、歧义、失效或未执行的数据保持未知，诊断失败不会覆盖原始输入失败。不记录控件正文或任意类名；诊断计数不能代替真实确认，也不能证明修复已通过真实 Wework E2E。

Windows 客户端在第一次 UIA 查询前，用 `ClientSettings.RegisterClientSideProviderAssembly` 显式注册与已加载 UIAutomationClient 相同版本和签名标识的官方 `UIAutomationClientsideProviders`。真实 CI 已确认默认查询返回 Pane 时，官方 Button factory 仍可为同一 HWND 创建 provider，因此初始化不能依赖该运行环境的默认代理绑定。注册异常保留为失败，注册开始／完成分别记录；不引入自定义 provider，不降低 Button 类型或 InvokePattern 要求，真实 Allow／Cancel 门禁仍必须通过。

真实 CI 直接从 PowerShell 调用官方注册 API 时抛出 `NullReferenceException`；微软实现通过调用栈推断引用版本。注册入口改为禁止内联的具名 CLR 方法，保证版本推断先遇到有效的声明类型，仍调用同一官方 API 和程序集。失败时只补固定方法标记，原异常仍使门禁失败。独立原生校验在已有 Windows job 的 Node 24 初始化后、整包构建前执行，保留原一分钟外层期限。

真实 Windows 原生验证也可能在 `FromHandle` 后因 UIA 身份不匹配而失败。失败分支仅追加 PID 匹配、Button 类型匹配、句柄匹配三个 0／1 标志和数值控件类型 ID；不记录控件名称或任意输出。未读到的数据保持未知，诊断异常另记固定阶段并保留原身份失败。日志必须先区分所有权与 provider 类型问题，不能据此跳过校验或宣称原生点击已修复。

MCP App 目录失败保留任务与线程标识、来源读取状态、是否执行恢复及来源读取后的耗时，不记录工具参数或凭据。原生 JSON-RPC 失败事件同时记录接收响应的进程类型（`shared`／`dedicated`）及 generation；请求编号只在其进程内有意义。初始化阶段或没有通知 Hub 的独立调用尚无 generation 时，明确记录 `unknown`，不能用相邻进程的编号补齐。仍使用既有错误脱敏与长度限制，不新增请求参数或响应正文日志。Windows 原生插件确认失败保留固定 UI Automation 阶段、退出信号和终止状态，不输出任意子进程内容。这些诊断用于后续定位，不能作为故障修复或官方 runtime 已兼容的证明。Windows 原生确认按隔离进程的顶层窗口逐个搜索子树，只接受同一进程、窗口类型、系统对话框类 `#32770` 和已知确认标题；仅调用匹配原生按钮的 InvokePattern。出现多个匹配对话框即失败，不按顺序随意选择。保留 10 秒搜索与 12 秒子进程时限，真实 Windows 结果仍需 CI 验证。

流式文本替身复用 `modelTextStream`，与单次 Chat Completions／Anthropic 文本回复共用帧格式，保持原有分块和节奏，按请求协议输出结束事件。不能在 Responses SSE 发送给其他协议后继续推进场景：原生重试可能在下一阶段被误认为新的业务请求。依赖指定模型目录能力的 fixture（如 `code_mode`）必须在每个新会话建立该前置条件，不能从前一个任务的选择推断新会话模型；通用文本场景继续覆盖当前有效协议。

自定义场景需要原生云凭据时，必须声明 `requiresNativeCloudAuthorization`，由共享 runner 在隔离 Electron 连接后完成真实 Backend 授权。自行管理多设备授权的场景声明 `requiresNativeCloudInspector`，并把当前 `control` 传给授权 fixture；首次启动与新设备重启均在连接完成后授权，不能在 `prepareApp` 或 `afterStop` 中使用尚未启动的原生进程。

模型替身中的协议无关文本回复必须复用 `writeLocalAssistantMessage`，按当前请求的 Responses、Chat Completions 或 Anthropic 协议发送完整结束事件。不要通过重置用户模型选择来迁就固定协议的替身，也不要将替身返回错误 SSE 格式造成的断流归因于官方 runtime。

共享模型入口在 Responses、Chat Completions、Anthropic 及官方 Codex Responses 路径上，均先按原生元数据或完整预测提示识别后台预测，再进入普通场景处理器；显式拥有预测行为的场景仍自行处理。预测回复按当前协议返回 JSON，不消耗前台场景计数或释放其挂起响应，不通过历史关键词猜测请求类型。

嵌套 Goal 场景必须逐层传递共享 runner 提供的模型请求上下文；恢复会话后的文本回复仍按当前请求协议发送。需要暂停或中断的文本流复用 `modelTextStream`，保留 Responses 的 commentary 阶段、原有释放条件和中断时不完成响应的语义，不调整业务断言或用户模型选择。

自定义场景的 `handleHttp` 第四个参数提供共享 `modelRequest`（协议名与 `reply(text)`）；非模型请求为 `null`。纯文本场景应使用该入口复用协议路由与回复，避免遗漏当前有效模型的请求路径。

模型目录覆盖等会被 Codex 缓存的配置必须在场景的 `prepareApp` 中写入，先于应用和共享 app-server 启动。`human-interactions` 在此阶段声明 `request_user_input_async`；不要等到 `verify` 才改配置或删除磁盘缓存，已经运行的进程可能仍使用旧目录。

Windows CI 以普通账户执行桌面测试。DingTalk 协议 fixture 在切换账户前编译到工作区，通过 `WEWORK_E2E_DWS_FIXTURE_BIN` 交给助理场景复用，避免依赖普通账户的 Rust 工具链。未提供预编译文件的本地运行仍在场景准备阶段编译。覆盖属于协议集成测试，不代表真实钉钉兼容性已验证。

Windows 原生 Core 插件确认失败时，`native-plugin-decision-failed` 只保留固定阶段、单调时钟耗时和已枚举的按钮数量。阶段分别覆盖窗口匹配、按钮枚举、名称读取、InvokePattern 读取和调用，便于区分最后一个已完成的步骤；不记录窗口正文、按钮文字或任意子进程输出。按钮数量缺失时为 `null`，不能当作零按钮。保留原有 10 秒查找／12 秒进程期限；这些诊断本身不证明原生点击问题已经修复。

## 共享 Codex 启动保护

MCP App 的来源读取、目录、资源、工具调用和会话保留使用所属任务的 Agent Home。线程由独立 app-server 持有时，请求通过该进程原有 JSON-RPC 流转发；线程恢复完成前排队，等待用户输入时仍处理读取，原生响应和通知保持顺序。关闭中的持有进程仍保留所有权，直到子进程回收完成。在通道关闭前未被接收的只读请求，使用同一个原始 RPC 时限等待所有权释放，再重新解析所属进程；持有期间不得转向共享进程。已派发请求、未知结果和工具调用均不重放。等待与释放阶段记录固定事件及耗时，不扩展期限。共享进程读取继续采用既有准备和发送时限。工具隔离、来源调用和插件／连接器授权检查保持生效。对应子进程协议测试使用合成服务，不证明官方 runtime 缺陷已经修复，真实 E2E 失败门禁仍保留。

共享 app-server 的启动看门狗必须同时考虑已有活动轮次和仍在准备 native 线程的轮次。另一个轮次尚未收到 `thread/start` 响应时，没有 thread ID 并不代表它可以被重启中断。准备阶段使用按客户端计数的生命周期保护，在初始化完成、失败或取消时释放；模型执行阶段继续由活动线程记录保护。不调整启动超时，也不重提已有轮次。

`executor/tests/codex_app_server_contract/startup.rs` 的进程级协议回归通过可观察的文件关卡阻塞第二个线程响应，跨过真实看门狗期限后再释放，验证两个轮次均能完成。该用例保留真实 Executor 和子进程 IPC，使用合成 Codex 协议服务；不代表真实 Codex 在同一故障注入下的兼容性已验证。

## 启动会话

构建时的 `prepare-codex-binary.mjs` 使用 Node 原生 HTTP/HTTPS 流下载锁定版本，处理重定向并删除失败的临时文件；归档通过完整性校验后才解包使用。下载流不依赖 Node 内置 Fetch 的 Undici 解析器，避免其异常终止构建进程。

```bash
pnpm --filter wework ai:verify start
```

命令会输出 session 文件路径和本地控制地址。它会创建独立的 Executor Home、项目目录、设备 ID、IPC socket、Electron app-data namespace 和诊断目录，并从源码应用目录启动真实 Electron。任务、项目、应用数据和单实例锁不会与正式版或其他验证会话共享。所有日志位于 `wework/test-results/ai-verify/<run-id>/`。

用户明确选择本机 Codex 账号时，设置 `WEWORK_E2E_NATIVE_CODEX_HOME` 为已登录的本机 Codex 目录，让原生账号机制为隔离实例提供认证。不得读取、打印或手工复制认证内容。复用自己的隔离数据时，`--executor-home` 必须为绝对路径；通过 `--device-id` 显式保留该 Home 的设备身份。

新会话在应用启动前记录实际认证路径、原有文件或链接是否存在以及原生 managed 标记的元数据。正常停止、控制器关闭和启动失败使用同一所有权清理：仅移除本会话新建、仍匹配标记与文件身份的认证链接或副本，不删除本机源账号、原有认证或用户替换文件。旧会话没有所有权记录时，默认私有 Home 保持原清理规则，指定的复用 Home 则保守保留；旧链接应由原始拥有它的默认会话执行 `stop` 清理。

认证所有权由原生创建器写入版本化标记，绑定会话随机标识和文件元数据，不包含认证内容。会话状态通过跨进程锁和原子替换写入，清理时重新读取最新状态，避免并发观察或旧快照覆盖已清理结果。不认识的所有权协议保守保留认证。

## 共享桌面 E2E 运行时镜像

完整源码的浅克隆不设置 `filter: blob:none`：工作目录需要全部 blob，过滤会把下载推迟到 checkout 的第二次 promisor 请求。仅变更分类任务保留完整提交历史及 blob 过滤，避免拉取历史文件内容。共享运行时合约测试检查浅克隆任务不引入这种额外请求。

独立 MinIO 的 API 端口由共享分配器分配，并排除固定版本的控制台默认端口 `13333`。该版本即使设置 `MINIO_BROWSER=off` 仍会检查端口相等并退出，详见固定源码的 [默认值](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/globals.go#L215)及[启动检查](https://github.com/minio/minio/blob/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a/cmd/common-main.go#L502)。端口回归直接从 `13333` 开始分配，验证排除后的端口可真实绑定；不靠重启 MinIO 掩盖冲突。

非草稿 PR 只触发 Wework 桌面 E2E 时，也必须启动 `e2e-tests.yml` 中的 Backend Rust 运行时生产任务，不能只以平台 E2E 是否运行作为条件。生产任务先检查内容寻址镜像是否存在，缓存命中时复用既有镜像；缓存未命中时构建并发布，供桌面构建消费。`ruby .github/scripts/test-backend-rs-e2e-runtime.rb` 覆盖平台、桌面和草稿 PR 的生产条件。

Linux 桌面 E2E 构建和缓存预热使用 `e2e-tests.yml` 生产的 Rust Backend OCI 镜像。消费者必须与生产方的 `SOURCE_DIGEST` 表达式保持一致，包括示例程序源码；只哈希主程序会生成无人发布的镜像标签，最终以 `manifest unknown` 超时失败。修改运行时镜像输入时，运行 `bash .github/scripts/test-wework-core-e2e-runtimes.sh`，检查桌面验证和缓存预热两个消费者与生产方的摘要契约。

## 操作与断言

Linux 隔离桌面使用 `Xvfb -noreset`，使显示服务在整个 checkpoint 内持续可连接。默认的“最后一个客户端断开即 reset”会在短连接 `xprop` 探测与 Openbox 连接之间关闭监听，详见 [Debian 的生命周期分析](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1095028#43)。不通过重启窗口管理器或延长等待隐藏启动失败。

后续命令都传入启动命令返回的 session 路径。优先使用稳定的 `data-testid` 选择器。

创建 Issue 后，API 列表中已存在该记录不代表详情界面已完成渲染。共享的 `createAndAssignCloudIssue` 流程使用 `clickWhenEnabled` 等待详情负责人控件出现并启用后再点击，沿用默认步骤时限；不能用 API 落库状态代替控件就绪，也不能用延时或重跑掩盖竞争。

```bash
pnpm --filter wework ai:verify snapshot --session /path/to/session.json
pnpm --filter wework ai:verify fill --session /path/to/session.json \
  --selector '[data-testid="chat-message-input"]' --value '验证内容'
pnpm --filter wework ai:verify click --session /path/to/session.json \
  --selector '[data-testid="send-message-button"]'
pnpm --filter wework ai:verify wait-for --session /path/to/session.json \
  --selector '[data-testid="message-assistant"]' --text '完成'
pnpm --filter wework ai:verify stop --session /path/to/session.json
```

可用操作包括 `snapshot`、`text`、`click`、`fill`、`press`、`wait-for`、`status` 和 `stop`。命令返回结构化 JSON；WebView 不可用、元素不存在或断言超时时，命令以非零状态退出。

富文本编辑器的 `fill` 先通过原生快捷键选择文本，再由宿主在一次调用中顺序输入各行及原生 Enter。宿主在当前聚焦 frame 中安装一次确认器，并在插入下一行前等待目标编辑器的可信 Enter keyup 处理完成；保留原来每个按键 10 秒的期限，不按行等待绘制帧。确认器支持 iframe 和 Shadow DOM，结束时移除监听器；清理失败单独记录且不覆盖原始输入错误。保留空行、中文和换行格式转换。不要直接把多行字符串交给 Chromium `insertText`，它在结构化编辑器中可能只保留第一行。现有 Electron CI 中的 `editor-native-input.test.mjs` 使用真实描述编辑器，对比逐行输入与批量输入的 Markdown 和段落结构，覆盖 31 段文本和空段落组成的 61 块结构，并验证 iframe 和 Shadow DOM 的多行输入；不放宽业务 E2E 的断言或超时。描述编辑器在 React commit 阶段同步外部值，防止延后的受控值回传覆盖更新的原生编辑。原生输入日志分别记录确认器安装、Enter 确认、文本插入、按键派发和清理耗时，不包含输入文字。

## 安全边界

控制器只监听 `127.0.0.1`，并为每个会话生成一次性 Bearer token。该通道只有在 `ai:verify start` 启动的开发实例中通过 Vite 环境变量启用；普通开发与生产构建不会暴露控制接口。session 文件包含 token，应视为短期本地凭据，不应提交或共享。

## 控制协议

WebView 启动后先调用 `/ready`，随后用短轮询请求 `/commands`。控制器在队列为空时立即返回 `204`；WebView 通过 `/control-tick` 做短暂节流，再发起下一次轮询。收到命令后，WebView 依次调用 `/started` 和 `/results`，分别确认命令已开始执行并提交最终结果。

`ai:verify` 和桌面端 E2E 共用这套协议，修改任一端时必须保持端点和轮询语义一致。不要把 `/commands` 改成长轮询：这会与 WebView 的控制循环冲突，使后续命令留在队列中并表现为连续超时。控制器还必须在命令超时后将其从队列移除，避免过期命令在下一次轮询中被执行。

## 原生应用菜单刷新

“查看 → 刷新”重新加载当前 Wework 窗口，快捷键为 macOS 的 `⌘R` 或 Windows/Linux 的 `Ctrl+R`。该菜单项在任务和设置页面均可用，直接调用当前窗口的 `webContents.reload()`。

`application-menu` 桌面 CI 检查点覆盖菜单项存在、设置页可见，以及刷新后控制通道重新连接、页面恢复和工作区导航可用。定向单测覆盖三种平台的快捷键、窗口重载及中英文标签。

测试控制命令 `refreshFromApplicationMenu` 先等待 `/results` 确认，再激活真实的原生菜单项，避免 renderer 卸载时丢失命令回执。控制协议单测通过延迟回执验证该顺序。

设置页保留后台的当前工作区标签。“工作 → 任务 / 项目空间”在设置页应重新选择目标标签并恢复其内容路由，即使该标签已经是当前标签；在正常工作区中则继续避免重复选择。

设置路由不写入工作区标签的类型或内容路由。在设置页重新加载时，标签管理器初始化正常工作区标签，设置页继续由应用路由显示，避免返回工作区时再次打开设置。

读取持久化标签时，校验会排除指向设置页的无效条目，并保留其他合法工作区标签。

## 原生右键菜单

Electron 不会为 WebContents 自动创建网页右键菜单。Wework 由 Electron 主进程统一监听 `context-menu`，并为主窗口、工作区窗口和辅助窗口构建原生菜单。

- 图片菜单保留复制图片、打开图片和本机文件操作。
- 可编辑区域必须读取 `params.isEditable` 和 `params.editFlags`，使用 Electron 的 `undo`、`redo`、`cut`、`copy`、`paste`、`delete`、`selectAll` 原生 role，并把 `params.frame` 传给 `menu.popup`。
- 非编辑区域的选中文本使用原生 `copy` role；没有可执行操作时不弹出空菜单，以免干扰 React 组件自己的业务右键菜单。

修改该链路时，先运行 `wework/electron/src/host/image-context-menu.test.ts`，再在隔离 Electron 会话的真实输入框中验证菜单弹出、菜单项可用状态和粘贴行为。WebView 的 DOM 快照不会包含 macOS 原生 `NSMenu`，不能用合成的 `contextmenu` 事件或仅浏览器截图代替真实桌面验证。

## 固定标签窗口恢复

固定标签分配到独立窗口后，Electron 会从本机偏好设置恢复其窗口标识和内容路由。恢复地址必须通过共享的 `resolveDshAppRoute` 添加 `/wework/app/` 前缀，并保留任务或项目查询参数、`workspaceTab`、`workspaceTabTitle` 和片段。直接加载未加前缀的内容路由会绕过 Wework 应用的深链接入口，导致恢复窗口无法正常显示。

桌面 CI 的 `workspace-tabs` 检查点覆盖固定标签拆出及应用重启，断言恢复窗口的路由、标签身份、固定状态，以及编辑区可见且能继续输入。针对性验证使用 `pnpm --filter wework e2e:desktop --segment workspace-tabs`。

## AI 验证流程

AI 应先执行 `snapshot` 确认路由和可用的 `data-testid`，再进行最小必要操作，并以 `wait-for` 加 `snapshot` 或 `text` 验证结果。结束时必须执行 `stop`；若失败，保留该会话目录中的 `app.log` 以便诊断。

## 录制验证视频

需要留存操作证据时，先确认 PATH 中的 FFmpeg 支持 `libx264`。用 `start --record true` 启动会话，主窗口就绪后开始录像，并在返回会话路径前采集首帧。也可以对已启动的会话执行 `record-start`，用 `record-stop` 结束当前片段，并按需开启下一段。

```bash
pnpm --filter wework ai:verify start --record true
pnpm --filter wework ai:verify record-stop --session SESSION
pnpm --filter wework ai:verify record-start --session SESSION
pnpm --filter wework ai:verify stop --session SESSION
```

`record-stop` 保存视频并输出路径。若录像仍在进行，`stop` 会先保存视频，再关闭会话，并输出视频路径。每段录像以独立的 MP4 文件保存在对应的 `wework/test-results/ai-verify/` 会话目录中。如果采集中断，录制器会尽量保存已采集画面，并在停止命令的错误信息中给出已保存的路径。

录像以每秒 5 帧采集隔离 Electron 主窗口内容，覆盖页面重载，无需 macOS 屏幕录制权限。采集范围不包含操作系统弹窗、原生菜单、独立窗口或音频。请将录像与实际断言结果一起作为验收证据，分享前检查画面中的敏感信息。录像和会话文件请保留在 Git 之外。

## 通用 DevTools 与性能分析

隔离验证实例通过主进程提供鉴权的 CDP 通道。它不经过渲染线程，因此在断点暂停时仍能读取事件并恢复执行。普通应用实例不注册此入口。先启动实例并枚举目标，将返回的 `id` 用作下面的 `ID`：

```bash
pnpm --filter wework ai:verify start
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"targets"}'
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"command","target":ID,"method":"Schema.getDomains"}'
pnpm --filter wework ai:verify performance-start --session SESSION --target ID
# 使用已有 click、fill、press、wait-for 等命令复现需要分析的操作。
pnpm --filter wework ai:verify performance-stop --session SESSION --target ID --output report.json
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"detach","target":ID}'
pnpm --filter wework ai:verify stop --session SESSION
```

`devtools` 接受任意当前 Chromium 支持的 `Domain.command`、`params` 和可选的 `sessionId`，不维护协议域白名单。可直接使用 `Network.getResponseBody`、`Network.getRequestPostData`、`Runtime.getProperties`、`Debugger.getScriptSource`、`Debugger.setBreakpointByUrl`、`DOM.getDocument`、`CSS`、`HeapProfiler` 和 `Tracing`；用 `Target.setAutoAttach` / `Target.attachToTarget` 获取子会话，再将返回的 `sessionId` 传回命令。协议能力与限制取决于本实例的 Chromium/Electron 版本，并不承诺 DevTools 面板自身的 UI 或扩展功能。参见 [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger)。

输入也可通过 `--file request.json` 提供；`--output result.json` 保存完整响应，适合源码、大对象或快照。启用所需协议域后，通过事件游标读取网络、console、异常、脚本和其他协议事件：

```bash
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"command","target":ID,"method":"Network.enable"}'
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"command","target":ID,"method":"Runtime.enable"}'
pnpm --filter wework ai:verify devtools --session SESSION --value '{"action":"events","target":ID,"after":0,"limit":1000}' --output events.json
```

将返回的 `next` 作为下一次 `after`；`latest` 表示当前末尾。读取不删除事件。每个目标最多保留 20,000 个事件或 32 MiB，超过时 `lost` 明确报告该游标遗漏的事件数量。高频采集应及时分页读取；大 trace 使用 `Tracing.start` 的 `ReturnAsStream`，再用 `IO.read` / `IO.close`，避免把整个 trace 填入事件缓冲区。重连必须先显式 `detach`；发生意外断开时仍能读取已保留事件及 `Inspector.detached` 原因。打开该目标的 DevTools 面板可能使 Electron debugger 断开，不要同时使用。

性能录制便捷命令复用上述通用协议，启用 CPU sampling、时间线、网络、console、异常和脚本事件。停止后自动生成：

- `report.json`：CPU self / inclusive 耗时、带线程信息的长任务和时间线汇总、慢请求及发起调用栈、重定向/失败/未完成请求、console 和异常、起止指标。
- `report.json.evidence.json`：原始 CPU profile、Chromium trace 和协议事件，便于复核及继续分析。

CPU 位置通过脚本声明的 source map 映射到原始文件、行、列；隔离 E2E 构建启用 source map，普通构建不因此暴露源码。内联、文件和网络 source map 均可读取，网络映射使用 CDP 加载。无法映射时保留生成代码位置并记录错误，AI 可继续调用 `Debugger.getScriptSource` 定位。CPU 耗时属于采样数据；父子 inclusive 耗时、嵌套 trace 时间不能相加。`lostEvents` 或 `traceDataLoss` 非零时证据不完整，应缩短录制或调整通用采集方式。便捷录制对根目标采样；worker 等子目标可使用通用协议单独采样。

网络正文和 console 对象的属性需按需用协议读取，报告不自动展开所有正文和远程对象。采集仅覆盖启用后发生的事件。报告与原始数据可能包含请求头、正文、日志等敏感信息，只保留在本地验证目录，不要提交仓库。最终用 `detach` 释放连接，始终用 `stop` 清理隔离实例。

### 用户故事与回归

`devtools-performance` checkpoint 在真实 Electron 中验证 AI 从发现目标到录制、复现、分析的完整流程：定位已知 CPU 热点并映射原始源码，捕获真实 HTTP 请求、console 和异常，读取 DOM，向 worker 子会话发送命令，在断点暂停后通过主进程恢复，再断开和重连。协议错误和重复录制必须明确失败且不破坏连接。它注册在现有 core CI 分片，无新增 CI 作业。

```bash
pnpm --filter wework e2e:desktop --segment devtools-performance
```

CPU 录制成功停止后，即使 trace 读取、解析或报告写入失败，也会清理录制状态并保留原始错误，允许下一次按需录制。若停止 profiler 本身失败，则保留尚未消费的录制状态。`devtools-performance` 还会制造真实的报告目录写入失败，验证随后可以重新开始并完成录制。

显式 `detach` 成功后会丢弃该目标未完成的录制状态，可用于取消录制或在意外断开后重新开始；detach 失败时保留状态。真实 Electron 回归也覆盖录制中断开后重新录制并生成报告。

所有桌面 checkpoint 共用结果目录内的 `desktop-control` 注册表，便于按需诊断自己的隔离实例。macOS 原生进程快照先读取 PID 父子关系，再只读取 Electron 进程树的详细指标和命令行，避免全机无关进程的参数撑满采集缓冲区。

### 差异预览 CPU 与工作台内存回归

差异预览使用 Pierre 的虚拟化渲染。行事件回调、渲染选项、行注解和布局度量应保持稳定；父组件刷新或更换事件处理函数不应重建未变化的代码 DOM。实际选项、差异内容或行注解变化时仍须更新。`FileChangesPatchDiff.test.tsx` 使用真实 Pierre 实例检查连续刷新时的节点身份及卸载清理。

工作台的记忆化回调分别定义在独立 Hook 的词法作用域中，不能重新合并进 Provider 的大型渲染作用域。否则依赖交替变化的回调会通过共享闭包串联保留历史任务、生命周期和工作列表快照。`workbenchCallbackLifetime.test.tsx` 使用 Inspector 触发真实 GC，并通过弱引用验证旧快照能够回收，同时约束 Provider 不再直接定义 `useCallback`。

CPU Trace 的采样时间、HTML 解析时间与进程内存应分别解释。共享内存采样同时保留已有渲染器 JS 堆读数、会话缓存计数及主进程 `process.memoryUsage()` 字节值；主进程 PID 与采样进程不符时保留 `null`。这些值与物理占用 KiB 分开解释，不额外触发主进程 GC，也不改变原采样窗口或内存门槛。macOS 内存用例失败仍保留失败门禁；构建和对象存储准备成功且作业未取消时，后续独立 Inspector 检查点继续运行，以保留其他场景的诊断覆盖。堆快照中的对象大小不等于活动监视器中的进程占用；单份堆快照能证明对象保留路径，不能独立证明内存增长速率。共享 runner 在原始失败写入后，可通过已校验 PID 及隔离 profile 的原生 Inspector 采集失败后主进程堆摘要。V8 快照自身的 GC 位于测量窗口之后，原预算及失败结果保留；摘要只含类别、浅层字节数及一条强引用路径，不代表 dominator 保留大小。原始堆仅暂存在测试驱动内存中，不写盘、不上传；超过 128MiB 或无法采集时明确标为不可用。分析文件保持本地，不提交用户 Trace 或堆快照。

E2E 操作窗口还记录浏览器原生 long task 与 long animation frame 的计数、总时长和峰值，`responsiveness` 预算可直接断言这些指标；不支持的计数返回不可用，不能按零通过。完整工作台诊断的 `rendererResponsiveness` 保存每个窗口最近 32 条归因记录与丢弃数，仅保留编译资产名、函数标识符、浏览器枚举及数字，不保留完整 URL、查询参数或页面内容。逐命令报告只传计数，详细记录不随每个命令重复传输。 完整归因事件同时经共享报错采集器保存为 info 记录，并关联 capture ID；详细快照的环形缓存截断不会静默丢失原始采集记录。 时长指标按每条事件向上取整为毫秒，详细记录保留浏览器原始精度。 每帧最多保留 3 条慢脚本详情，`omittedSlowScripts` 明确报告省略数量；慢脚本计数和峰值始终根据该帧全部慢脚本计算，不受详情上限或排序影响。详情优先保留耗时最长的脚本，耗时相同时再按强制布局耗时排序，避免纯 JS 卡顿被较短的布局调用挤出。

内存快照还会从应用 HTTP Worker 读取同 PID 的 `process.memoryUsage()` 字节计数，并与原生进程树核对后保存为 `appWorkerMemory`。该只读端点仅在显式 E2E 模式启用，不返回环境、参数或堆内容；未知 PID、无效计数和采集失败不能替换为零，也不触发 GC。

空闲任务轮询通过注册 ACK 的 `runtime_work_catalog_probe` 能力协商按需模型目录：新 Backend 的 `catalog_probe` 仅检查待处理或未确认工作，不领取任务、不发布目录；空队列仍返回工作区清理意图。存在候选工作后才调用 `runtime.runner.catalog`，随后走原有权限校验和原子领取路径。待准备的分配也参与探测，避免旧目录阻止新模型发现。未声明该能力的旧 Backend 保留原有轮询行为；重连时重新协商，修复随 Backend 升级生效。探测是保守的队列提示，不承诺候选工作最终可领取。

目录探测与正式领取共用当前设备授权、路由／亲和性、工作时间及执行范围占用过滤；探测暂缓模型目录可用性判断，返回提示不会授予执行权限，后续发布新目录并重新执行原子领取。

浏览器登录页 E2E 复用桌面套件的真实 Rust／Python Backend、MySQL、Redis 和 MinIO，以及 CI 已构建的 Backend 产物。先完成后端准备，再启动 Vite，并将 HTTP／Socket.IO 代理指向本轮隔离端口。登录页保留原有可见性断言，同时要求真实 `/api/users/me` 返回未认证的 401，连接失败或服务端错误不能替代认证结果。仅模型服务使用替身；未使用的 Sites／Connector 替身不启动。浏览器后端日志单独上传，桌面场景的采样数量不代表浏览器采集覆盖。

Playwright 用例使用 `e2e/fixtures/collected-test` 的自动采集 fixture，复用 `E2EErrorLog` 脱敏日志和 `DesktopErrorCollector` 逐条断言。网络响应、连接失败、页面异常、控制台错误及崩溃保留原级别；页面关闭后确认日志写入和连续序号，再核对显式错误预期。浏览器模式读取既有默认偏好，不调用仅由 Electron 提供的偏好接口；Electron 读取失败继续报错。浏览器模式不启动原生事件轮询和托盘同步；未登录时尚未建立 Socket 连接的跳过分支记录为普通信息，实际连接及鉴权失败继续记录错误。`errors.expectHttpError(response, status)` 绑定真实请求 ID；客户端结构化 HTTP 报错额外用该次请求实际携带的 `X-Request-ID` 及状态关联，每种匹配记录精确断言一条；同一 URL、实际状态和原因完全对应的 Chromium 控制台记录最多允许一条。其他预期用 `errors.expectError(predicate, count)` 显式登记，未匹配错误失败。日志及断言摘要附在 Playwright 报告中；这不证明浏览器外部进程或所有 Worker 的覆盖。

浏览器采集绑定整个 BrowserContext 的请求、响应、异常和控制台事件；新建页面及弹窗注册崩溃、关闭和 WebSocket 观察。WebSocket 使用独立连接 ID 记录打开、socketerror 和关闭，不记录帧载荷。测试收尾先关闭本轮 context，再确认日志 checkpoint，覆盖页面与连接的关闭阶段。

首次目录发布也是明确的目录需求：Backend 在尚未保存有效 `runnerCatalog` 时通过探测要求读取一次，避免任务准入依赖目录、目录读取又依赖任务入队的循环。已发布的有效空目录不会触发重复空闲读取；后续候选探测仍沿用设备授权和领取前复核。

模型代理请求日志用本地 `request_id` 关联请求开始与上游响应头。响应头记录区分 `client_build_ms`（HTTP 客户端构建）与 `upstream_wait_ms`（发送、等待及既有重试的合计），总 `elapsed_ms` 另含请求转换等前置阶段；这些时间不能等同于上游服务处理时间。未取得响应头时保留阶段未知，不补零。

共享原生 RPC 在请求帧完成写入后记录 `codex native request sent`，仅包含方法、请求 ID、进程代际、Executor PID 与写入耗时，不记录参数。结合上层请求开始、原生 turn 事件及结构化失败身份，区分宿主写入前等待和写入后的运行时等待；已写入不表示已执行或业务成功。

已有会话的历史读取和搜索沿用 `requestLocalExecutor` 的底层代理配置门禁，不等待模型目录准备，也不为读取历史改写目录或重启 Codex。模型准备仍由发送／模型操作路径负责；代理配置失败仍会阻止原生读取并完整报错。

macOS 进程样本同时保留同一次原生 `footprint` 读取的 `native_memory_categories`，区分堆分配、代码段、栈及其他映射的 dirty／swapped／clean／reclaimable／wired 字节与 region 数量。只保留系统类别白名单；其他标签合并为 `other`，不记录进程名称、映射路径或堆内容。缺少分类时为 `null`，不能解释为零；分类总量不替代物理占用，也不独立证明对象泄漏。

macOS 原生物理内存采样对缺值 PID 核对系统进程状态：已消失及明确的 `Z` 僵尸后代不属于活动内存，记录在 `exited_processes`／样本的 `exitedProcesses`，不伪造零内存。`kill(pid, 0)` 成功不能单独证明进程仍在运行。主进程缺值、活动后代缺值以及状态不可用仍失败，并只记录 PID、父 PID、分组、可执行文件名及状态；不记录命令参数、不用 RSS 替代，也不重采样求通过。

MCP App 请求从来源核验、冷会话恢复到工具派发复用统一线程活动范围，自动空闲重启需等该操作完成，避免核验与调用落在不同 app-server 代次。该范围在操作完成或取消后释放；已派发调用的结果未知仍明确返回，禁止自动重放有副作用的工具。

日志排空复用进程停止的 10 秒时限等待来源管道关闭。超过时限时，保存已接收的字节、释放采集器持有的可读流，并以 `ERR_PROCESS_OUTPUT_UNCLOSED` 明确失败；不把截断日志视为完整，也不把场景成功变为最终通过。受管子进程统一绑定 stdout／stderr，两路流的状态均包含所属 PID、退出码和信号，区分应用退出与管道 EOF；没有句柄持有者证据时，不宣称已定位原生运行时根因。

浏览器 Playwright 使用编译产物；CI 通过 `WEWORK_E2E_PREBUILT_WEB_ARCHIVE` 复用同一次共享桌面构建中的界面，未配置归档的本地运行先构建界面。启动器将真实 Backend 地址写入现有 `runtime-config.js`，以 `/wework/app/` 为应用基路径提供静态资源，不再在断言期间进行 Vite 源模块转换。匿名会话 401 在明确的登录路由请求中验证，随后验证应用根路径跳转；不依赖开发 StrictMode 的重复 effect，原业务断言与时限保留。

Windows 原生决定客户端与只读窗口观察器都在共享 runner 准备阶段预编译，并按源码摘要命名独立 DLL。原生输入阶段只加载已准备的客户端；不在原 12 秒输入窗口中动态编译 C#。缺少准备产物仍失败，UIA 的 PID、原生句柄、对话框类、按钮名称、唯一性与调用方式检查保留；CI 继续用真实 Windows 对话框验证允许和取消。两类 DLL 分离，失败后的只读观察器不依赖 UIAutomation，也不发送输入。

E2E 模式下，Executor 记录原生 `commandExecution` 开始／结束通知的接收和分发时刻、原生生命周期时刻与耗时、线程／轮次／条目 ID 及进程代际。未提供的原生时刻保留为空；不记录命令、目录或输出，也不把通知分发耗时等同工具运行耗时。Windows 关闭前另存不含标签和参数的所属进程快照；管道排空失败时只查询这些 PID 的创建时刻，缺失或查询失败明确区分，PID 存活不能单独证明同一进程或管道持有者。

Windows 进程树终止必须检查 `taskkill` 退出码。部分后代终止失败即以 `ERR_WINDOWS_PROCESS_TREE_TERMINATION` 保留目标 PID 和退出码；即便父进程已经退出，也不能把该步骤记录为成功。它不证明失败后代一定持有日志句柄，日志排空门禁继续独立执行。

共享 Windows 桌面 runner 对源码构建应用，在其执行第一条指令之前将其加入原生 Job Object，停止时必须由该容器确认活动进程数为零；父进程退出或 PID 消失均不构成整树停止证明。监督进程使用现有 Executor 二进制的独立入口，不修改官方 runtime、应用参数或原业务断言。应用 stderr 通过无损协议帧传输，与监督进程自身输出按真实 PID 分开记录；监督输出复用同一脱敏错误日志实现，并保存独立采集回执，写入失败仍阻断验证。原生停止失败、协议无效或超时继续失败；非容器路径仍保留 taskkill 非零门禁，日志排空门禁不变。

终止命令失败后也立即记录已知所属 PID 的存活／创建时刻，之后的排空失败另存一次；原始失败继续抛出，不自动重试终止。

项目动态的私有来源解析记录消息 ID、序号、版本、来源状态、地址是否存在及查询耗时；初始快照、广播接收和定向解析分开记录。记录失效版本和离开订阅的结果，不记录消息内容、原始 traceRef 或 Runtime 地址，不改变成员权限或接受旧响应。

Wework 将这些安全字段通过消息客户端的诊断回调接入既有 `reportE2EDiagnostic` 通道，作为 info 记录持久化到共享 journal；调试面板环形缓存不再是唯一证据来源。
