---
sidebar_position: 19
---

# Connector Apps 架构与部署

Connector Apps 让 Wework 在不修改 Codex 源码、也不依赖 ChatGPT 登录的前提下连接组织内部系统。上游既可以是 MCP Server，也可以是普通 HTTP API。系统把“App”拆成三个独立职责：Wegent Admin 管理定义、可见范围和固定请求头，Wegent Backend 读取 `kinds` 中的 ConnectorApp 资源并适配上游协议，Executor 向 Codex 统一暴露本地 MCP。Wework 不提供 Connector 设置页面，只在连接 Wegent 云端后同步可用能力。

## 运行链路

1. 管理员在 Wegent 的“系统管理 → 应用连接”中配置远程 MCP，或配置 HTTP API 基础地址和工具定义，同时设置可见角色、工具白名单和可选固定请求头。
2. 当前版本仅支持 `auth_type: none`。管理员为组织内部系统配置加密固定请求头时，应用会自动对允许的角色生效；系统不保存用户 Bearer Token，也不提供 OAuth 授权流程。
3. 用户将 Wework 连接到 Wegent 云端后，Wework 自动同步当前用户可用的 Connector Apps 和对应 Skills。
4. Wework 使用当前云端会话申请 15 分钟的 Connector 专用 JWT。该 JWT 只有 `connectors:invoke` 权限，不能替代用户登录令牌。
5. Executor 把自身注册为普通 stdio MCP Server `wegent_apps`。Codex 只连接这个本地进程，不接触上游固定请求头。
6. `wegent_apps` 子进程从 Executor 私有目录读取自动轮换的短期 JWT，并调用 Wegent Connector Runtime。Backend 解密管理员固定请求头，并连接上游 Streamable HTTP/SSE MCP，或把工具调用转换为普通 HTTP 请求。
7. 每个可用 App 会生成一个由 Wegent 管理的本地 Skill。Skill 只声明该 App 可使用的工具命名空间，例如 `crm__`，不会包含管理员填写的描述或任何凭据。

工具名统一为 `<app_slug>__<upstream_tool_name>`。管理员设置工具白名单后，列表和调用两个入口都会执行同一检查，不能通过直接构造工具名绕过。

## HTTP API 适配

当连接协议选择 `HTTP API` 时，端点地址表示 API 基础地址。管理员通过 `http_tools` 定义每个工具：

- `name`、`description`：暴露给模型的工具名称与用途。
- `method`、`path`：允许 `GET`、`POST`、`PUT`、`PATCH`、`DELETE`；`path` 必须是相对当前主机的绝对路径引用，不能携带其他域名、查询串或片段。
- `input_schema`：标准 JSON Schema object，Runtime 会在发送请求前再次校验参数。
- `argument_locations`：把参数映射到 `path`、`query` 或 JSON `body`。未显式配置时，GET/DELETE 参数进入 query，其他方法进入 JSON body；路径占位符会自动进行 URL 编码。
- `timeout_seconds`：单次请求超时，范围 1–120 秒。

Backend 不跟随 HTTP 重定向，避免固定请求头被带到其他主机；响应上限为 1 MB。JSON 响应同时转换为 MCP 文本内容和结构化内容，非 2xx 状态会作为 MCP Tool Error 返回。Provider 固定请求头、角色可见性和工具白名单与 MCP 上游使用完全相同的策略。

## 认证边界

Connector 当前支持以下 App 认证方式：

| 类型 | 用途 | 凭据位置 |
| --- | --- | --- |
| `none` | 上游不需要用户单独授权，或由管理员统一管理身份 | 无用户凭据；可配置管理员固定请求头 |

管理员可配置加密固定请求头，例如内部 API Key 或服务令牌，而无需每个用户单独连接。固定请求头不会通过管理 API 回显；管理 API 只返回是否已配置以及请求头名称。当前版本不提供 `bearer` 或 `oauth2` 用户授权入口，也不再保存用户级 connector token。

## 部署配置

生产部署必须保护项目通用敏感数据加密配置 `GIT_TOKEN_AES_KEY` 和 `GIT_TOKEN_AES_IV`。Connector Apps 使用现有 `encrypt_sensitive_data` 机制把固定请求头加密后写入 `Kind.json.spec.providerHeadersEncrypted`。密钥必须由密钥管理系统注入，不能提交到仓库；轮换密钥前需要制定现有加密字段的迁移方案。

```bash
GIT_TOKEN_AES_KEY="$(openssl rand -base64 24 | head -c 32)"
GIT_TOKEN_AES_IV="$(openssl rand -base64 12 | head -c 16)"
```

当前版本没有 Connector OAuth callback，也不需要配置第三方授权回调地址。生产环境应使用 HTTPS。内部 MCP 可以使用 HTTP，但只能由受信任管理员配置，并应由网络策略限制 Backend 的出站范围。

## 数据与生命周期

- Connector App 定义存储在 `kinds` 表中，`kind = "ConnectorApp"`，`namespace = "system"`，`metadata.name` 对应 app `slug`。
- App 可声明为 MCP 上游或 HTTP API 上游；主要配置位于 `Kind.json.spec`。
- 管理员固定请求头加密后存储在 `Kind.json.spec.providerHeadersEncrypted`。
- 旧版 `connector_apps`、`connector_connections`、`connector_oauth_sessions` 数据表已迁移/移除；当前版本没有用户连接记录和 OAuth 临时会话。
- App 停用后会立即从用户目录和 Runtime 中消失。
- 管理员可以替换或显式清除固定请求头；留空编辑框默认保留已加密的现值。
- Wework 会在下一次同步时移除不可见或已停用 App 对应的本地生成 Skill。
- Connector 专用 JWT 只会写入 Executor 私有目录下权限为 `0600` 的运行时文件，不会写入 Codex 配置；子进程每次请求都重新读取，过期后不可使用。
- Wework 云端断开后，Executor 删除运行时短凭证文件、移除 `wegent_apps` MCP 配置和生成的 Connector Skills；本地 Codex 工作流继续可用。

## API 分层

以下路径使用默认 `API_PREFIX=/api`；如果部署配置了其他 API 前缀，请替换为实际值。

- `/api/admin/connector-apps`：管理员目录 CRUD。
- `/api/connector-apps`：当前用户可见目录；响应中的 `connection` 字段只是兼容前端的数据投影，不对应 `connector_connections` 数据行。
- `/api/apps/list`、`/api/apps/read`、`/api/apps/installed`：Wework/Codex app 投影。
- `/api/connector-runtime/token`：用普通云端会话签发最小权限短凭证。
- `/api/connector-runtime/tools`、`/call`：仅接受 Connector 专用 JWT，供 Executor MCP 代理调用。

这个设计不使用 Codex 的原生 `codex_apps` Server。原生 Server 的 ChatGPT 认证和远端 App 目录属于 Codex 自身能力；Wegent 在 Executor 边界统一转换成标准 MCP，因此上游无论是 MCP 还是 HTTP API，都无需修改或登录 Codex。
