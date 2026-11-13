---
sidebar_position: 39
---

# AI 自验证会话

Wework 支持启动隔离的开发验证会话，让 AI 在真实 Electron 应用中完成 UI 操作和断言。该机制复用桌面端 E2E 的 WebView 控制通道，不会操作外部 Chrome，也不会连接开发者日常使用的 Wework 窗口。

## 空闲 Executor 请求回归

`idle-executor-requests` 使用无任务、断开云端的隔离真实 Electron 和 Executor，复用共享 runner 的首次遥测拒绝流程，然后重新加载主窗口并观测请求。启动后的工作树能力发现、遥测配置和共享 SSE 订阅必须各一次；前台与关闭到后台各观察 6.5 秒，跨过 5 秒轮询周期，要求继续发现待处理交互并保留 Runtime 身份检查，禁止全量任务目录轮询和重复启动配置。异步插件等已知启动请求允许完成，不以固定延时推断启动完成。

同一同步批次的身份描述读取只在尚未发出时共享；操作后的身份校验仍读取新的描述。已确认的本地 Runtime 遥测策略不随空闲轮询重写，Runtime、账户、API 或策略变化时重新同步，失败后重试。工作列表变更仅刷新任务数据，设备发现仍由设备事件和显式刷新负责。工作事件不会取消进行中的完整云端同步，而是合并为同步完成后的一次最新任务读取；bootstrap 的设备与团队同步也不会因任务读取版本变化而丢失。

恢复最近项目必须等待本地工作列表结束初始加载；先到达的云端合成列表不能消耗这次恢复机会。设备或云端目录可独立发布，不能将其到达误判为本地项目已经就绪。

```bash
pnpm --filter wework e2e:desktop --segment idle-executor-requests
```

检查点注册在现有 Core CI 分片，独立运行不依赖前序场景。本地 macOS arm64 验证含启动与清理耗时约 52 秒，共享构建另计。结果目录的 `idle-executor-requests.json` 只保存方法名、时间、状态和必要布尔标志，不保存请求参数、头或查询字符串；日志和截图不得提交。

## 插件周期恢复 E2E

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

执行器的 `runtime task model selection updated` 记录内存中的模型赋值。`runtime task get resolved link` 和 `runtime task transcript resolved link` 记录读取任务的模型身份。赋值日志不代表磁盘写入已经成功。

`configured` 不等于磁盘中的原始任务记录。对于现有对话，配置来自任务摘要或运行句柄。对于新对话，配置来自项目配置或用户偏好。

复现时按以下步骤收集证据：

1. 在重启前导出反馈包。
2. 重启应用。
3. 在首次发送前再次导出反馈包。
4. 核对执行器读取的模型身份。
5. 比较输入框的配置、有效值和选择值，区分模型记录缺失、默认值替代和输入框切换。

## 桌面 E2E 启动前准备

模型目录覆盖等会被 Codex 缓存的配置必须在场景的 `prepareApp` 中写入，先于应用和共享 app-server 启动。`human-interactions` 在此阶段声明 `request_user_input_async`；不要等到 `verify` 才改配置或删除磁盘缓存，已经运行的进程可能仍使用旧目录。

Windows CI 以普通账户执行桌面测试。DingTalk 协议 fixture 在切换账户前编译到工作区，通过 `WEWORK_E2E_DWS_FIXTURE_BIN` 交给分身场景复用，避免依赖普通账户的 Rust 工具链。未提供预编译文件的本地运行仍在场景准备阶段编译。覆盖属于协议集成测试，不代表真实钉钉兼容性已验证。

## 共享 Codex 启动保护

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

CPU Trace 的采样时间、HTML 解析时间与进程内存应分别解释。堆快照中的对象大小不等于活动监视器中的进程占用；单份堆快照能证明对象保留路径，不能独立证明内存增长速率。分析文件保持本地，不提交用户 Trace 或堆快照。
