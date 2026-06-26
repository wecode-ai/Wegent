---
sidebar_position: 32
---

# 本地优先云端连接

Wework 默认是完整本地应用。本机 Codex、本地 executor、本地工作区和本地会话不依赖 Backend 登录或云端设备。云端连接是一个可选能力层：用户在侧栏输入 Backend 地址并完成 WeWork 登录后，服务端模型、云设备和云端 Codex 认证同步会加入同一个工作台。

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

- 默认功能：本机 Codex、本地 executor、本地工作区和本地会话。
- 连接云端后：服务端模型、云设备、云端 Codex `auth.json` 同步、代理和远程设备管理。

云设备、代理配置和云端 Codex 认证同步都必须通过云端连接访问。未连接时页面展示连接入口或禁用态，不会把本机状态误写入服务端。

## 服务合并

工作台服务由三层组成：

1. `createLocalAppServices()` 提供本地 IPC、本机设备、本地运行时任务和本机 Codex 模型。
2. `createBackendWorkbenchServices()` 封装 Backend HTTP、Socket.IO、模型、设备和运行时任务 API。
3. `createHybridWorkbenchServices()` 在云端已连接时合并本地和云端服务。

未连接时，Wework 继续只使用本地服务。已连接时，模型、设备和 runtime work 列表合并展示；执行和流式订阅按设备或来源路由到本地 IPC 或 Backend relay。

## 模型命名

前端合并层必须避免本机 Codex 和云端同步 Codex 的模型名冲突。UI 使用唯一名称：

```text
local:runtime:codex-gpt-5.5
cloud:runtime:codex-gpt-5.5
```

执行前通过模型上的 `weworkExecution` 元数据映射回原始 `modelName` 和 `modelType`。后端仍收到 `codex-gpt-5.5` 和 `runtime`，不会破坏已有 Codex 模型解析。

## 本机认证状态

本机 Codex `auth.json` 状态通过 executor 的只读 `runtime_auth_status` 命令读取。命令只返回：

- 是否存在。
- 目标路径。
- 更新时间。
- 文件大小。
- SHA-256 摘要。

它不会返回明文内容。Wework 也不会默认上传本机认证文件。只有用户在云端 Codex 认证页面显式上传或从在线设备导入后，认证内容才进入服务端加密存储和设备同步流程。

## 断开连接

断开云端连接只清除云端连接存储，不影响：

- 本地会话。
- 已打开的本地工作区。
- 本机 Codex 模型。
- 本机 executor。

断开后，云设备、服务端模型、代理和云端认证同步回到不可用或连接入口状态。
