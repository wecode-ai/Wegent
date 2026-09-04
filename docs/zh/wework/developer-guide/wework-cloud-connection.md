---
sidebar_position: 32
---

# 本地优先云端连接

Wework 默认就是一个完整的本地应用。本机 Codex、本地模型配置、本地 executor、本地工作区和本地会话不依赖 Backend 登录或云端设备。云端连接是一个可选能力层：用户在侧栏输入 Backend 地址并完成 WeWork 登录后，服务端模型、云设备和云端 Codex 认证同步会加入同一个工作台。

打包时可通过 `VITE_WEGENT_BACKEND_URL` 设置“连接云端”中的默认 Backend 地址。该值仅用于预填，用户仍可修改；本机已有的连接地址优先于打包默认值。配置该变量后，桌面端左下角账户区在未连接时显示“Wegent 账户 / 未登录”，点击后仍打开完整账户菜单；用户从菜单顶部的“登录 Wegent”进入云端授权。连接成功后，账户区显示云端用户名和邮箱；账户菜单中的“退出登录”只会断开云端连接。

## 状态归属

云端连接状态由 `cloud-connection` 前端层管理，和网页版登录使用的全局 `auth_token` 分开存储。它持久化以下信息：

- 用户输入的 Backend 根地址。
- 归一化后的 `apiBaseUrl`、`socketBaseUrl` 和 `socketPath`。
- 云端登录 token、过期时间、云端用户和连接时间。
- 当前状态：未连接、连接中、已连接、过期或错误。

打包的 Electron 桌面端会把 renderer 的完整 `localStorage` 镜像到应用
`userData` 目录中的 `renderer-local-storage.json`，并在前端初始化其他服务之前恢复。
因此 Core DSH 重启后即使随机端口变化导致页面 origin 改变，云端连接、本地模型、
未发送草稿、布局和其他使用 `localStorage` 的界面偏好仍会保留。主进程串行处理变更，
通过原子替换写入文件，并在 Unix 系统上使用 `0600` 权限。用户主动断开连接、删除配置
或清空对应状态时，同样会同步删除持久化副本；不使用 Electron host 的网页版不经过
这层桌面镜像。主进程还会在加载新的 Core DSH origin 前清理旧 origin 的 Chromium
`localStorage`：已有权威快照但尚无 origin 记录时执行一次全量迁移清理，之后只精确
清理上一次记录的 `scheme://host:port`。当前 origin 写入
`renderer-local-storage-origins.json`，同 origin 的 renderer 重建不会重复清理。
首次还没有权威快照时保留浏览器存储，避免在建立持久化副本前丢失迁移数据。

用户可以输入 Backend 根地址，也可以直接输入 `/api` 地址。前端会把地址归一化为 HTTP API 地址和 Socket.IO 连接信息。连接时先请求 `/health`，再调用 `/auth/wework/sessions` 创建短生命周期授权会话。Backend 返回完整 `authorize_url`，本地 Wework 在内置授权窗打开该云端授权页，并携带 `poll_token` 轮询会话结果。

桌面端授权窗默认尺寸为 `1000 × 640`，最小尺寸为 `960 × 620`，以完整容纳没有响应式布局的企业登录页。窗口完成定位前保持隐藏，显示后置顶于普通窗口，并在 Wework 主窗口移动或显示器缩放比例变化时重新定位。位置以 Wework 当前显示器的可用区域为边界；macOS 直接使用 AppKit 的统一逻辑桌面坐标，因此在 Retina 与非 Retina 显示器之间移动时不会因物理像素和逻辑像素换算而漂移到屏幕外。

Socket.IO 地址按以下优先级解析：用户在连接窗口显式输入的地址、与当前 Backend 匹配的打包 Socket 地址、Backend `/auth/wework/config` 返回的 `socket_url`、Backend 同源默认地址。Backend 通过 `WEGENT_SOCKET_URL` 声明公开 Socket.IO origin；HTTPS 部署应配置 `wss://` 地址。启动时也会按同一优先级刷新并迁移已保存连接。Wework 会把最终解析出的地址通过 Electron IPC 传给本机 executor；executor 使用该地址建立 Backend Socket.IO 连接，而 HTTP API 仍使用 Backend 地址，因此分离部署不需要用户再次手工配置 WSS 地址。

本地 Wework 不渲染云端账号密码表单，也不调用 `/auth/login` 或 `/auth/admin-password/setup`。云端登录、OIDC 和管理员初始化都发生在云端 Wegent Web 授权页中。用户登录后必须明确点击“授权 Wework”，Backend 才会把一次性可领取的云端 JWT 写入授权会话；本地 Wework 领取成功后继续读取 `/users/me` 校验用户并保存云端连接状态。

Backend 使用 `WEWORK_AUTHORIZE_BASE_URL` 生成授权页地址；未配置时复用 `FRONTEND_URL`。因此 API/Web 分离部署时必须显式配置 Web 根地址，Wework 客户端只打开 Backend 返回的完整 `authorize_url`，不自行推断网页版地址。

## 交互入口

桌面侧栏提供两个职责明确的云端入口：

- 工作区入口展示云端连接状态。未连接时显示“连接云端”，登录过期时显示“云端连接已失效”；点击后可重新连接，也可使用“断开连接”清除失败或过期状态并恢复为未连接状态。
- 左下角账户区始终打开账户菜单，不因登录状态改变点击行为。未登录时菜单顶部展示“登录 Wegent”，设置、检查更新和剩余用量仍然可访问。
- 已连接时账户区显示云端用户名和邮箱，工作区入口显示云端主机、云端用户和在线云设备数量。
- 登录过期或连接错误不会阻塞本地功能。

工作区入口中的“云端工作”状态来自团队、设备和云端任务列表的完整后台探测，而不是已缓存的历史数据。第一次探测期间显示“同步中”；第一次探测完成后，后续刷新期间继续显示最近一次“可用”“无设备”或“不可用”结论，直到本次完整探测结束。只要任一云端读取失败，最新结论就是“不可用”，即使界面仍使用最后一次成功快照保留历史设备或任务数据。重叠刷新会取消旧请求并由最新的一次完整探测接管，不能只刷新设备或回退成历史“可用”状态。

设置页按能力分组：

- 默认功能：本机 Codex、本地模型配置、本地 executor、本地工作区和本地会话。
- 连接云端后：服务端模型、云设备、云端 Codex `auth.json` 同步、代理和远程设备管理。

“模型”是本地模型和 Codex `auth.json` 的统一入口。本地模型配置始终可用；云端 Codex 认证同步、上传、导入和代理开关都必须通过云端连接访问。未连接时页面只展示本机 auth 状态和云端能力说明，不会把本机状态误写入服务端。

## 服务合并

工作台服务由三层组成：

1. `createLocalAppServices()` 提供本地 IPC、本机设备、本地运行时任务、本机 Codex 模型和用户配置的本地模型。
2. `createBackendWorkbenchServices()` 封装 Backend HTTP、Socket.IO、模型、设备和运行时任务 API。
3. `createHybridWorkbenchServices()` 在云端已连接时合并本地和云端服务。

未连接时，Wework 继续只使用本地服务。已连接时，模型、设备和 runtime work 列表合并展示；执行和流式订阅按设备或来源路由到本地 IPC 或 Backend relay。

输入框的新会话偏好也遵循连接状态归属。未连接时，模型、推理强度、协作模式以及每个项目的本地工作区/工作树模式写入 Wework 本机用户配置；连接云端后，这些选择通过 Backend 用户 API 写入当前云端账号，重启后从同一账号恢复。Backend 使用 `wework_new_chat_model_selection` 保存模型及其 `options`，使用 `wework_project_work_preferences` 按 `project:<id>` 保存 `executionMode` 和 `worktreeBranch`。混合服务不得继续把已连接账号的偏好写入本机用户存储，否则当前窗口虽然会显示新选择，重启后仍会回到云端账号中的旧值或默认值。

## 云端 Runtime IPC 中继

Wework 云端 runtime 执行使用和本地模式一致的 app IPC 协议。前端连接 Backend 的 `/wework-runtime` Socket.IO namespace，把 `runtime.*` 请求包装成 `{ id, method, params, device_id }` 帧；Backend 只负责鉴权、校验在线设备和转发到对应 executor，不把这条链路翻译成 `chat:*` 事件。

云端 executor 仍连接 Backend 的 `/local-executor` namespace。executor 内部复用本地 `RuntimeWorkRpcHandler` 执行 `runtime.tasks.create`、`runtime.tasks.send`、`runtime.tasks.list`、`runtime.tasks.transcript` 等方法，并把 Responses API 风格的 app IPC event 通过 `runtime:event` 透传回 `/wework-runtime`。Wework 前端复用本地流式事件 mapper 消费这些事件，因此本地模式和云端模式在 runtime 执行流程上保持一致。

`device.execute_command` 的中继超时必须使用请求中的 `timeout_seconds`，并在前端确认等待上增加固定宽限时间。普通 runtime 请求继续使用默认 75 秒。这样 Git Clone 等长命令不会被外层 IPC 在命令自身超时之前提前判定失败，同时仍受 executor 的 600 秒上限约束。

多实例 Backend 通过 Socket.IO Redis manager 把 RPC 转发到持有 executor 连接的 worker。Redis 中带 `socket_id` 的设备在线记录是转发入口；不能用当前 worker 的进程内连接表预判 executor 已断线，否则会把连接在其他 worker 上的设备误标为离线。

## 本机 executor 生命周期

打包 release 版 Wework 必须和本机 executor 保持一对一活跃配套。release app 启动时只允许一个活跃 Wework 实例；重复启动会聚焦已有窗口。app 直接启动并管理 executor 子进程，通过 stdin/stdout JSONL 通道通信，不使用共享 socket、TCP 地址文件或进程发现。

debug 构建不启用单实例策略。开发时可以同时启动多个 Wework debug 实例；每个实例只持有自己子进程的 stdio，不存在端点覆盖或误连其他 executor 的情况。不同实例是否共享持久化任务目录仍由 Executor Home 隔离配置决定，与 IPC 通道无关。

关闭到托盘只销毁当前 WebView，Wework 主进程、executor 和 Codex app-server 继续运行。窗口重建后，`runtime.tasks.transcript` 返回的 `running` 字段用于恢复任务运行态；该字段只以 executor 进程内的活动任务或 Codex app-server 的实时线程状态为依据，不能从历史 transcript 中残留的 `streaming` 消息推断。完整退出或异常退出后，新 executor 不保留旧进程的活动状态，因此旧消息不会把已经中断的任务重新标记为运行中。

## 本机 CLI 入口

macOS 桌面版 Wework 启动时会安装用户级 `wework` launcher 到 `~/.local/bin/wework`。该文件由 Wework 生成和维护，不是指向构建产物或 app resource 的符号链接，因此 debug target 清理、release app 更新或 bundle 路径变化后不会形成断链。若该路径已经存在且不是 Wework 管理的 launcher，Wework 不会覆盖它，而是写入明确的日志告警。

用户可以在终端执行：

```bash
wework
wework .
wework /path/to/project
wework desktop instances
wework desktop inspect --project .
```

`wework` 和 `wework .` 会把当前目录解析为绝对路径，并请求 Wework 打开该目录作为本机 workspace。release 构建通过 macOS app single-instance 机制把请求转发给已有窗口；debug 构建仍允许多实例，CLI 会启动当前 debug executable 并携带 `--open-workspace <path>` 参数。

`desktop` 是同一个 `wework` CLI 的实例控制子命令，不会再安装或注入另一个同名命令。
Wework 管理的 Agent 环境和 macOS 用户级入口使用同一套分发规则，因此
`wework <目录>` 始终打开 workspace，而 `wework desktop ...` 始终操作已运行实例。

## 模型身份与执行传输

模型在 UI、任务状态和执行请求中始终使用同一份规范身份：`name`、`type`、`namespace` 和 `resourceUserId`。前端不得为了区分本机与远程执行而添加 `local:`、`cloud:` 前缀，也不得在模型配置中保存额外的 transport source。模型目录合并时，如果 Backend 合成的 runtime Codex 模型与 Executor 实时目录具有相同 `modelId`，保留 Executor 实时模型。

目标设备只决定传输方式：本机设备通过 IPC 调用 Executor，远程设备通过 WebSocket relay 调用 Executor。两条路径都使用相同的 `runtime.tasks.*` 协议和模型选择。公共、个人和组模型的资源身份会随请求传给 Executor，由同一个模型网关解析。用户配置的本地模型使用 `local-model:<config-id>`；选择云端或远程设备时，Wework 会在发送前按需同步该模型的 Codex 能力目录，并把任务所需的模型连接配置直接交给目标 Executor。

本机 Codex 模型目录只跟随当前 Codex 配置中的 active provider。executor 通过 Codex app-server 读取一次 `config/read` 获取当前 `model_provider` 和展示名，再调用一次 `model/list` 获取该 provider 对应的模型列表。即使 `config.toml` 中配置了多个 `[model_providers.*]`，Wework 也不把它们枚举成多个并列模型组，因为 Codex 的 `model/list` 不提供按 provider 查询的稳定协议。需要在 Wework 中展示多个模型接口时，应使用下方的本地模型配置。

## 本地模型配置

本地模型配置（包括 API Key）仅存储在 Wework 的浏览器本机存储中，不作为 Model CRD 写入 Backend，也不会成为账号级持久化配置或参与云端同步。Wework 运行时不访问桌面系统凭据库；如果旧版本只把某个 API Key 保存在系统凭据库中，升级后需要在“设置 → 模型”中重新填写该 API Key。配置字段包括：

- 显示名。
- 模型 ID。
- 上游接口格式：OpenAI Responses、OpenAI Chat Completions 或 Anthropic Messages。
- 模型基础 URL 和请求路径。默认路径随接口格式分别为 `/responses`、`/chat/completions` 和 `/v1/messages`，特殊服务商可使用自己的路径。
- 工具模式：`custom`、`function` 或 `shell`。原生支持 Responses custom tools 的模型使用 `custom`；Chat/Anthropic 转换使用 `function`；会拒绝 freeform custom tools 的原生 Responses 模型使用 `shell`。
- 可选 API Key。
- 可选上下文窗口大小。
- 启用状态和更新时间。

API Key 留空时，本地 runtime 会向 Codex provider 配置传入 `dummy` bearer token，用于支持无鉴权的本地 OpenAI-compatible 服务。本地模型配置和内置本机 Codex 模型都会以 `UnifiedModel(type: "runtime")` 进入现有模型选择器。

“测试连接”会强制模型调用一个确定性的能力探针工具，只有模型返回对应 tool call 才通过；普通文本回复不能证明模型具备 Agent 工具能力。`custom` Responses 模式使用 Codex 的 `apply_patch` custom tool 名称和 grammar 完成探针，`function` 模式使用普通函数探针。OpenAI Responses 探针使用 `stream: true` 并从 SSE 事件读取工具调用，与 Codex 实际执行路径一致，也能兼容非流式响应中 `output` 为空的提供方。执行任务时，executor 会为该自定义模型生成显式 Codex model catalog：`custom` 和 `function` 模式发布 `apply_patch`，`shell` 模式仅发布 shell 编辑工具。

DeepSeek V4-Flash 和 V4-Pro 是内置 provider profile：上游地址为 `https://api.deepseek.com/responses`，模型目录 ID 分别为 `wework-deepseek-v4-flash` 和 `wework-deepseek-v4-pro`，上下文窗口均为 1,048,576 tokens，推理等级支持 `low`、`high`、`max` 且默认使用 `high`。模型目录开启并行工具、multi-agent v2 和 Web Search，只声明文本输入，不声明图片生成。Wework 从 DeepSeek `/models` 发现模型后只保留当前 Codex profile 支持的 `deepseek-v4-flash` 和 `deepseek-v4-pro`；旧版由该 profile 管理的 Chat Completions 配置会在读取时迁移到 Responses API、`custom` 工具模式和实时搜索。

在云端或远程设备中首次选择本地模型，或者本地模型配置发生变化后再次使用时，Wework 会在真正创建或继续任务之前显示确认框。用户确认后，Wework 将当前本地自定义模型目录写入目标 Executor，使用 `ifIdle` 语义重启该设备维护的 persistent Codex app-server，并通过 `model/list` 校验目标模型已经加载；校验成功后才继续发送当前消息。同一设备和同一配置版本在当前 Wework 会话内只需要确认一次。

如果目标 Codex 存在运行中任务或待处理请求，Wework 不会强制重启，也不会清空当前输入，而是提示用户等待任务结束后重试。用户取消确认时同样不会创建乐观任务或发送消息。模型 API Key 和连接地址只随已确认的执行请求及目录准备操作发送到所选目标 Executor，不会写入 Backend 模型资源。

上下文窗口大小只接受正整数。前端保存后会进入本地模型的 `config.model_context_window`，本地 IPC 创建 Codex 任务时继续写入 `model_config.model_context_window`，executor 再转为 Codex 启动配置中的 `model_context_window` 覆盖项。Wework 的背景信息窗口也必须使用当前任务自己的 `modelSelection` 解析对应模型配置，避免 Codex 对未知模型使用默认模型目录上限时把用户配置的窗口显示成默认值。

新建 runtime task 时，模型选择必须作为任务状态的一部分写入 `runtimeHandle.modelSelection`，并同时保存在 optimistic task summary 中。`runtime.tasks.create` 响应也要返回同一个 runtime handle。这样在任务列表刷新尚未带回新任务、但流式上下文统计已经到达时，前端仍然能从当前任务地址读取确定的模型选择，而不是从全局“当前选中模型”推断。

## 代理配置边界

“代理”页面分别管理本地设备代理和云端设备代理，二者不能互相复用：

- 本地设备代理存储在 Wework 本机浏览器存储中，只影响当前 Wework App 通过本机 executor 创建的新 Codex 任务。它不会写入 Backend，不会同步到云端设备，也不会修改系统代理或用户 shell 环境。
- 云端设备代理存储在云端账号配置中，只影响云端 executor 上的 Codex 任务。本地设备不会使用该地址。

本地设备代理保存后不会立即中断正在运行的 Codex 任务。界面会提示用户手动重启 Codex；用户确认后，Wework 只重启当前 App 本机 executor 内维护的 persistent Codex app-server，不会终止机器上其他 Codex 进程。新 Codex app-server 启动时会获得代理相关环境变量，后续新对话会使用该代理。

Codex Responses 兼容模型可能通过 executor 内置的 `codex responses proxy` 转发到上游模型服务。对于用户在 Codex `config.toml` 中配置的自定义模型 provider，该转发器会使用任务携带的同一份本地设备代理访问上游；否则模型请求会绕过 Codex app-server 进程环境。日志只记录是否配置代理，不输出代理 URL。

## 本机认证状态

本机 Codex `auth.json` 状态通过 executor 的只读 `runtime_auth_status` 命令读取。命令只返回：

- 是否存在。
- 目标路径。
- 更新时间。
- 文件大小。
- SHA-256 摘要。

它不会返回明文内容。Wework 也不会默认上传本机认证文件。只有用户在已连接云端的“模型”页面显式上传或从在线设备导入后，认证内容才进入服务端加密存储和设备同步流程。

Wework 的 Codex 剩余额度展示以本机 Codex 账号为准。Electron 主进程通过受认证的本地 executor IPC 调用 `runtime.codex.rate_limits.read`，读取 Codex app-server 的 `account/rateLimits/read` 快照，并展示 5 小时和 7 天窗口的剩余百分比。主进程还通过 `runtime.tasks.list` 统计运行中的本地任务，并通过 `executor.backend.quota` 使用 executor 已持有的云端连接读取云端额度；认证令牌不会暴露给主进程。系统托盘每 60 秒刷新一次，并在任务开始或结束时立即刷新，因此主窗口关闭到托盘后仍能持续更新任务数和额度。

macOS 托盘需要同时显示 Logo、运行状态和最多两行额度文字。Electron 主进程应直接合成 RGBA template 位图，再交给原生托盘显示；不要依赖 `nativeImage` 对 SVG 文本或 Data URL 的栅格化，因为该路径可能只保留文字宽度而丢失实际字形像素。

## 断开连接

断开云端连接只清除云端连接存储，不影响：

- 本地会话。
- 已打开的本地工作区。
- 本机 Codex 模型。
- 本地模型配置。
- 本机 executor。

断开后，云设备、服务端模型、代理和云端认证同步回到不可用或连接入口状态。
