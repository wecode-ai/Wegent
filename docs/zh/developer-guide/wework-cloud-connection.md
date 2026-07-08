---
sidebar_position: 32
---

# 本地优先云端连接

Wework 默认就是一个完整的本地应用。本机 Codex、本地模型配置、本地 executor、本地工作区和本地会话不依赖 Backend 登录或云端设备。云端连接是一个可选能力层：用户在侧栏输入 Backend 地址并完成 WeWork 登录后，服务端模型、云设备和云端 Codex 认证同步会加入同一个工作台。

## 状态归属

云端连接状态由 `cloud-connection` 前端层管理，和网页版登录使用的全局 `auth_token` 分开存储。它持久化以下信息：

- 用户输入的 Backend 根地址。
- 归一化后的 `apiBaseUrl`、`socketBaseUrl` 和 `socketPath`。
- 云端登录 token、过期时间、云端用户和连接时间。
- 当前状态：未连接、连接中、已连接、过期或错误。

用户可以输入 Backend 根地址，也可以直接输入 `/api` 地址。前端会把地址归一化为 HTTP API 地址和 Socket.IO 连接信息。连接时先请求 `/health`，再复用 WeWork 登录表单调用 `/auth/login`；需要初始化管理员密码时复用同一套 admin 初始化表单。

## 交互入口

桌面侧栏底部展示云端入口：

- 未连接时显示“本地模式 / 连接云端”。
- 已连接时显示云端主机、云端用户和在线云设备数量。
- 登录过期或连接错误时提示重新登录，但本地功能继续可用。

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

## 本机 executor 生命周期

打包 release 版 Wework 必须和本机 executor 保持一对一活跃配套。release app 启动时只允许一个活跃 Wework 实例；重复启动会聚焦已有窗口。首次启动本机 executor 前，app 会清理使用 release 固定 `WEGENT_EXECUTOR_APP_IPC_SOCKET` 的旧 `wegent-executor` 进程和 stale socket，再启动当前 app 管理的 executor，避免新 app 连接到旧实例遗留的 executor。

debug 构建不启用这个单实例和清理策略。开发时可以同时启动多个 Wework debug 实例；每个实例使用 `app-runtime/wework-.../app-ipc.sock` 形式的独立 socket。release 清理旧 executor 时也必须检查进程环境中的 socket 值，只能终止使用 release 固定 socket 的 executor，不能误杀 debug 实例对应的 executor。

## 模型命名

前端合并层必须避免本机 Codex、用户配置本地模型和云端同步 Codex 的模型名冲突。UI 使用唯一名称：

```text
local:runtime:codex-gpt-5.5
local:runtime:local-model:<config-id>
cloud:runtime:codex-gpt-5.5
```

执行前通过模型上的 `weworkExecution` 元数据映射回原始 `modelName` 和 `modelType`。本地 IPC 执行边界再把本机 Codex UI 模型名规范化为 Codex app-server 接受的真实模型 id，例如 `codex-gpt-5.5` 会在发送前转换为 `gpt-5.5`。用户配置的本地模型使用 `local-model:<config-id>`，只允许投递到本机 device；如果目标是云端任务，前端会阻止发送并提示用户切换设备或模型。云端 relay 仍按模型来源传递原始执行模型名。

本机 Codex 模型目录只跟随当前 Codex 配置中的 active provider。executor 通过 Codex app-server 读取一次 `config/read` 获取当前 `model_provider` 和展示名，再调用一次 `model/list` 获取该 provider 对应的模型列表。即使 `config.toml` 中配置了多个 `[model_providers.*]`，Wework 也不把它们枚举成多个并列模型组，因为 Codex 的 `model/list` 不提供按 provider 查询的稳定协议。需要在 Wework 中展示多个模型接口时，应使用下方的本地模型配置。

## 本地模型配置

本地模型配置存储在浏览器本机存储中，不写 Backend，也不参与云端同步。配置字段包括：

- 显示名。
- 模型 ID。
- OpenAI Responses 兼容模型基础 URL 和请求路径。默认请求路径是 `/responses`，特殊服务商可使用自己的请求路径。
- 可选 API Key。
- 可选上下文窗口大小。
- 启用状态和更新时间。

API Key 留空时，本地 runtime 会向 Codex provider 配置传入 `dummy` bearer token，用于支持无鉴权的本地 OpenAI-compatible 服务。本地模型配置和内置本机 Codex 模型都会以 `UnifiedModel(type: "runtime")` 进入现有模型选择器。

上下文窗口大小只接受正整数。前端保存后会进入本地模型的 `config.model_context_window`，本地 IPC 创建 Codex 任务时继续写入 `model_config.model_context_window`，executor 再转为 Codex 启动配置中的 `model_context_window` 覆盖项。Wework 的背景信息窗口也必须使用当前任务自己的 `modelSelection` 解析对应模型配置，避免 Codex 对未知模型使用默认模型目录上限时把用户配置的窗口显示成默认值。

新建 runtime task 时，模型选择必须作为任务状态的一部分写入 `runtimeHandle.modelSelection`，并同时保存在 optimistic task summary 中。`runtime.tasks.create` 响应也要返回同一个 runtime handle。这样在任务列表刷新尚未带回新任务、但流式上下文统计已经到达时，前端仍然能从当前任务地址读取确定的模型选择，而不是从全局“当前选中模型”推断。

## 代理配置边界

“代理”页面分别管理本地设备代理和云端设备代理，二者不能互相复用：

- 本地设备代理存储在 Wework 本机浏览器存储中，只影响当前 Wework App 通过本机 executor 创建的新 Codex 任务。它不会写入 Backend，不会同步到云端设备，也不会修改系统代理或用户 shell 环境。
- 云端设备代理存储在云端账号配置中，只影响云端 executor 上的 Codex 任务。本地设备不会使用该地址。

本地设备代理保存后不会立即中断正在运行的 Codex 任务。界面会提示用户手动重启 Codex；用户确认后，Wework 只重启当前 App 本机 executor 内维护的 persistent Codex app-server，不会终止机器上其他 Codex 进程。新 Codex app-server 启动时会获得代理相关环境变量，后续新对话会使用该代理。

Codex Responses 兼容模型可能通过 executor 内置的 `codex responses proxy` 转发到上游模型服务。该转发器也必须使用同一份本地设备代理；否则模型请求会绕过 Codex app-server 进程环境。日志只记录是否配置代理，不输出代理 URL。

## 本机认证状态

本机 Codex `auth.json` 状态通过 executor 的只读 `runtime_auth_status` 命令读取。命令只返回：

- 是否存在。
- 目标路径。
- 更新时间。
- 文件大小。
- SHA-256 摘要。

它不会返回明文内容。Wework 也不会默认上传本机认证文件。只有用户在已连接云端的“模型”页面显式上传或从在线设备导入后，认证内容才进入服务端加密存储和设备同步流程。

Wework 的剩余额度展示也以本机 Codex 账号为准。前端先读取本机 `auth.json` 状态；如果没有 Codex 账号，则菜单和托盘显示“无”。如果本机已有账号，前端通过本地 executor 的 `runtime.codex.rate_limits.read` 命令读取 Codex app-server 的 `account/rateLimits/read` 快照，并展示 5 小时和 7 天窗口的剩余百分比。桌面系统托盘每 60 秒刷新一次这两个数值，只显示额度百分比，不上传认证内容，也不使用 Backend 的 Claude 额度作为替代。

## 断开连接

断开云端连接只清除云端连接存储，不影响：

- 本地会话。
- 已打开的本地工作区。
- 本机 Codex 模型。
- 本地模型配置。
- 本机 executor。

断开后，云设备、服务端模型、代理和云端认证同步回到不可用或连接入口状态。
