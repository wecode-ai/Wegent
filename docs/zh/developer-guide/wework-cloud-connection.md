---
sidebar_position: 32
---

# 本地优先云端连接

Wework 默认是完整本地应用。本机 Codex、本地模型配置、本地 executor、本地工作区和本地会话不依赖 Backend 登录或云端设备。云端连接是一个可选能力层：用户在侧栏输入 Backend 地址并完成 WeWork 登录后，服务端模型、云设备和云端 Codex 认证同步会加入同一个工作台。

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

“模型设置”是本地模型和 Codex `auth.json` 的统一入口。本地模型配置始终可用；云端 Codex 认证同步、上传、导入和代理开关都必须通过云端连接访问。未连接时页面只展示本机 auth 状态和云端能力说明，不会把本机状态误写入服务端。

## 服务合并

工作台服务由三层组成：

1. `createLocalAppServices()` 提供本地 IPC、本机设备、本地运行时任务、本机 Codex 模型和用户配置的本地模型。
2. `createBackendWorkbenchServices()` 封装 Backend HTTP、Socket.IO、模型、设备和运行时任务 API。
3. `createHybridWorkbenchServices()` 在云端已连接时合并本地和云端服务。

未连接时，Wework 继续只使用本地服务。已连接时，模型、设备和 runtime work 列表合并展示；执行和流式订阅按设备或来源路由到本地 IPC 或 Backend relay。

## 模型命名

前端合并层必须避免本机 Codex、用户配置本地模型和云端同步 Codex 的模型名冲突。UI 使用唯一名称：

```text
local:runtime:codex-gpt-5.5
local:runtime:local-model:<config-id>
cloud:runtime:codex-gpt-5.5
```

执行前通过模型上的 `weworkExecution` 元数据映射回原始 `modelName` 和 `modelType`。本地 IPC 执行边界再把本机 Codex UI 模型名规范化为 Codex app-server 接受的真实模型 id，例如 `codex-gpt-5.5` 会在发送前转换为 `gpt-5.5`。用户配置的本地模型使用 `local-model:<config-id>`，只允许投递到本机 device；如果目标是云端任务，前端会阻止发送并提示用户切换设备或模型。云端 relay 仍按模型来源传递原始执行模型名。

## 本地模型配置

本地模型配置存储在浏览器本机存储中，不写 Backend，也不参与云端同步。配置字段包括：

- 显示名。
- 模型 ID。
- OpenAI Responses 兼容模型 URL。
- 可选 API Key。
- 启用状态和更新时间。

API Key 留空时，本地 runtime 会向 Codex provider 配置传入 `dummy` bearer token，用于支持无鉴权的本地 OpenAI-compatible 服务。本地模型配置和内置本机 Codex 模型都会以 `UnifiedModel(type: "runtime")` 进入现有模型选择器。

## 本机认证状态

本机 Codex `auth.json` 状态通过 executor 的只读 `runtime_auth_status` 命令读取。命令只返回：

- 是否存在。
- 目标路径。
- 更新时间。
- 文件大小。
- SHA-256 摘要。

它不会返回明文内容。Wework 也不会默认上传本机认证文件。只有用户在已连接云端的“模型设置”页面显式上传或从在线设备导入后，认证内容才进入服务端加密存储和设备同步流程。

## 断开连接

断开云端连接只清除云端连接存储，不影响：

- 本地会话。
- 已打开的本地工作区。
- 本机 Codex 模型。
- 本地模型配置。
- 本机 executor。

断开后，云设备、服务端模型、代理和云端认证同步回到不可用或连接入口状态。
