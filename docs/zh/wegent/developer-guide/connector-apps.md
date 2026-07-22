---
sidebar_position: 19
---

# Connector Apps 架构与部署

Connector Apps 让 Wework 在不修改 Codex 源码、也不依赖 ChatGPT 登录的前提下连接组织内部系统。上游既可以是 MCP Server，也可以是普通 HTTP API。系统把“App”拆成三个独立职责：Wegent Admin 管理定义和认证策略，Wegent Backend 保存加密凭据并适配上游协议，Executor 向 Codex 统一暴露本地 MCP。Wework 不提供 Connector 设置页面，只在连接 Wegent 云端后同步可用能力。

## 运行链路

1. 管理员在 Wegent 的“系统管理 → 应用连接”中配置远程 MCP，或配置 HTTP API 基础地址和工具定义，同时设置认证方式、可见角色和工具白名单。
2. 管理员为组织内部系统使用 `none` 认证并配置加密固定请求头时，应用会自动对允许的角色生效。需要用户身份的 Bearer 或 OAuth 应用必须先通过 Wegent Web/API 完成授权；Wework 不承载配置或授权界面。
3. 用户将 Wework 连接到 Wegent 云端后，Wework 自动同步当前用户可用的 Connector Apps 和对应 Skills。
4. Wework 使用当前云端会话申请 15 分钟的 Connector 专用 JWT。该 JWT 只有 `connectors:invoke` 权限，不能替代用户登录令牌。
5. Executor 把自身注册为普通 stdio MCP Server `wegent_apps`。Codex 只连接这个本地进程，不接触用户的 OAuth、Bearer Token 或上游固定请求头。
6. `wegent_apps` 子进程从 Executor 私有目录读取自动轮换的短期 JWT，并调用 Wegent Connector Runtime。Backend 解密凭据，并代表用户连接上游 Streamable HTTP/SSE MCP，或把工具调用转换为普通 HTTP 请求。
7. 每个可用 App 会生成一个由 Wegent 管理的本地 Skill。Skill 只声明该 App 可使用的工具命名空间，例如 `crm__`，不会包含管理员填写的描述或任何凭据。

工具名统一为 `<app_slug>__<upstream_tool_name>`。管理员设置工具白名单后，列表和调用两个入口都会执行同一检查，不能通过直接构造工具名绕过。

## HTTP API 适配

当连接协议选择 `HTTP API` 时，端点地址表示 API 基础地址。管理员通过 `http_tools` 定义每个工具：

- `name`、`description`：暴露给模型的工具名称与用途。
- `method`、`path`：允许 `GET`、`POST`、`PUT`、`PATCH`、`DELETE`；`path` 必须是相对当前主机的绝对路径引用，不能携带其他域名、查询串或片段。
- `input_schema`：标准 JSON Schema object，Runtime 会在发送请求前再次校验参数。
- `argument_locations`：把参数映射到 `path`、`query` 或 JSON `body`。未显式配置时，GET/DELETE 参数进入 query，其他方法进入 JSON body；路径占位符会自动进行 URL 编码。
- `timeout_seconds`：单次请求超时，范围 1–120 秒。

Backend 不跟随 HTTP 重定向，避免认证头被带到其他主机；响应上限为 1 MB。JSON 响应同时转换为 MCP 文本内容和结构化内容，非 2xx 状态会作为 MCP Tool Error 返回。Provider 固定请求头、用户 Bearer/OAuth 凭据、角色可见性和工具白名单与 MCP 上游使用完全相同的策略。

## 认证边界

Connector 支持以下 App 认证方式：

| 类型 | 用途 | 凭据位置 |
| --- | --- | --- |
| `none` | 上游不需要用户身份 | 无用户凭据 |
| `bearer` | 用户提供个人访问令牌 | Wegent Backend 加密存储 |
| `oauth2` | OAuth 2.0 Authorization Code + PKCE | Wegent Backend 加密存储 access/refresh token |

OAuth token endpoint 支持 `client_secret_post`、`client_secret_basic` 和公共客户端 `none`。前两种机密客户端模式必须配置 Client Secret；公共客户端不保存 Secret。OAuth state 在数据库中仅保存 SHA-256 摘要；PKCE verifier、Client Secret、用户 Token 和固定请求头使用 `USER_AES_KEY` 进行 AES-256-CBC 加密，每条密文使用独立随机 IV。state 单次使用；失败或过期后必须重新发起授权。

`none` 也适用于由管理员统一管理身份的内部系统：管理员可配置加密固定请求头，例如内部 API Key，而无需每个用户单独连接。固定请求头和 OAuth Client Secret 不会通过管理 API 回显；管理 API 只返回是否已配置以及请求头名称。

## 部署配置

生产部署必须设置独立的 32 字节 `USER_AES_KEY`（也可使用 `base64:` 前缀的 Base64 编码密钥）。密钥必须由密钥管理系统注入，不能提交到仓库；轮换密钥前需要制定现有 Connector 凭据的重新授权或迁移方案。

```bash
USER_AES_KEY="base64:$(openssl rand -base64 32)"
```

如果 Backend 通过反向代理暴露，且请求推导出的地址不是第三方 OAuth Provider 可访问的公网地址，请设置：

```bash
CONNECTOR_OAUTH_CALLBACK_BASE_URL=https://wegent.example.com
```

使用默认 `API_PREFIX` `/api` 时，最终回调地址为：

```text
https://wegent.example.com/api/connector-apps/oauth/callback
```

必须把该地址登记到 OAuth Provider；如果部署使用的 API prefix 不是默认值，请把 `/api` 替换为实际配置。生产环境应使用 HTTPS。内部 MCP 可以使用 HTTP，但只能由受信任管理员配置，并应由网络策略限制 Backend 的出站范围。

## 数据与生命周期

- `connector_apps`：管理员发布的 App 定义。
- `connector_connections`：用户与 App 的连接及加密凭据。
- `connector_oauth_sessions`：短期、单次 OAuth state 与 PKCE 会话。
- App 停用后会立即从用户目录和 Runtime 中消失，并删除既有用户连接；重新启用后用户需要重新授权。
- 修改 MCP 地址、认证类型或 OAuth 客户端配置会删除既有用户连接，避免旧凭据被发送到新的安全边界。
- 管理员可以替换或显式清除固定请求头；留空编辑框默认保留已加密的现值。
- 用户连接记录被删除后，Wework 会在下一次同步时移除对应的本地生成 Skill；`none` 类型不依赖用户连接记录。
- 删除 Wegent 中的连接不会自动调用第三方 Provider 的令牌撤销接口；需要彻底撤销第三方授权时，用户还应在 Provider 的账号安全页面撤销该授权。
- Connector 专用 JWT 只会写入 Executor 私有目录下权限为 `0600` 的运行时文件，不会写入 Codex 配置；子进程每次请求都重新读取，过期后不可使用。
- Wework 云端断开后，Executor 删除运行时短凭证文件、移除 `wegent_apps` MCP 配置和生成的 Connector Skills；本地 Codex 工作流继续可用。

## API 分层

- `/api/admin/connector-apps`：管理员目录 CRUD。
- `/api/connector-apps`：当前用户可见目录、授权和断开连接。
- `/api/connector-runtime/token`：用普通云端会话签发最小权限短凭证。
- `/api/connector-runtime/tools`、`/call`：仅接受 Connector 专用 JWT，供 Executor MCP 代理调用。

这个设计不使用 Codex 的原生 `codex_apps` Server。原生 Server 的 ChatGPT 认证和远端 App 目录属于 Codex 自身能力；Wegent 在 Executor 边界统一转换成标准 MCP，因此上游无论是 MCP 还是 HTTP API，都无需修改或登录 Codex。
