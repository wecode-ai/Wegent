---
sidebar_position: 19
---

# Connector Apps 架构与部署

Connector Apps 让 Wework 在不修改 Codex 源码、也不依赖 ChatGPT 登录的前提下连接组织内部系统。上游既可以是 MCP Server，也可以是普通 HTTP API。系统把“App”拆成三个独立职责：Wegent Admin 管理定义、可见范围和固定请求头，Wegent Backend 读取 `kinds` 中的 ConnectorApp 资源并适配上游协议，Executor 向 Codex 统一暴露本地 MCP。Wework 不提供 Connector 设置页面，只在连接 Wegent 云端后同步可用能力。

## 运行链路

1. 管理员在 Wegent 的“系统管理 → 应用连接”中配置远程 MCP，或配置 HTTP API 基础地址和工具定义，同时设置可见角色、工具白名单和可选固定请求头。
2. `auth_type: none` 适用于上游无需用户单独授权的系统，管理员可配置加密固定请求头。`auth_type: oauth2` 支持标准 MCP OAuth：Backend 按 RFC 9728/8414 发现授权服务器，按 RFC 7591 动态注册公开客户端，使用 Authorization Code + PKCE S256 和 RFC 8707 resource 参数完成授权；用户 token 加密保存并自动刷新。管理员可选填 OAuth scope，留空时使用授权服务器声明的全部 scope。
3. 用户将 Wework 连接到 Wegent 云端后，Wework 自动同步当前用户可用的 Connector Apps 和对应 Skills。
4. Wework 使用当前云端会话申请 15 分钟的 Connector 专用 JWT。该 JWT 只有 `connectors:invoke` 权限，不能替代用户登录令牌。
5. Executor 把自身注册为普通 stdio MCP Server `wegent_apps`。Codex 只连接这个本地进程，不接触上游固定请求头。
6. `wegent_apps` 子进程从 Executor 私有目录读取自动轮换的短期 JWT，并调用 Wegent Connector Runtime。Backend 解密管理员固定请求头，并连接上游 Streamable HTTP/SSE MCP，或把工具调用转换为普通 HTTP 请求。
7. 每个可用 App 会生成一个由 Wegent 管理的本地 Skill。Skill 只声明该 App 可使用的工具命名空间，例如 `crm__`，不会包含管理员填写的描述或任何凭据。

工具名统一为 `<app_slug>__<upstream_tool_name>`。管理员设置工具白名单后，列表和调用两个入口都会执行同一检查，不能通过直接构造工具名绕过。

## 工具加载方式

管理员通过 `Kind.json.spec.toolLoadingMode` 选择工具加载方式。管理后台新增应用时默认使用 `lazy`；切换为 `static` 会弹出确认，提示其会一次性注入全部工具。直接调用 API 且未传该字段时，服务端仍按 `static` 处理：

| 方式 | 行为 | 适用场景 |
| --- | --- | --- |
| `static` | 所有已授权 App 的工具进入共享 `wegent-connectors` MCP，每个任务都能直接看到（Static loading / 静态全局加载） | App 少、使用频率高 |
| `lazy` | 为 App 生成 `wegent-connector-<slug>` Skill；只有 Skill 被选中、关键词命中或 `load_skill` 加载后才连接该 App 的 MCP（Lazy loading / 按需加载） | App 多、工具重或低频使用 |

`lazy` 模式不进入共享 MCP，而是使用带 `X-Connector-App` 请求头的 scoped MCP 端点。该端点只列出并允许调用指定 App 的工具；共享 `wegent-connectors` 只返回 `static` App。`lazy` App 的 `keywords` 用于消息命中：每条关键词按子串匹配，包含空格的词组要求所有词同时出现（例如 `钉钉 表格`）；命中后会把该 App 的 scoped MCP 写入请求的 `mcp_servers`，同时 preload 对应 connector Skill 提示，任务启动时即可使用工具。未命中的 lazy App 仍只在 `load_skill` 时连接 MCP。未授权 App 在对话内按需提示授权，Wework 继续使用 `connector_auth_required` 卡片。

管理后台新增应用时，`keywords` 默认填入应用的显示名和标识名；标识名中的 `-`、`_` 会替换为空格（例如 slug `dingtalk_ai_table` 生成 `dingtalk ai table`）。管理员手动修改关键词后，不会再随名称自动变化。

授权提示只在对话内按需出现：待授权的 `static` App 会直接提示；待授权的 `lazy` App 只有在当前消息命中名称或 `keywords` 时才提示。页面不再展示全局“待授权应用数量”Banner；“设置 → 集成”仍可查看和手动授权全部可见应用。

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
| `oauth2` | 上游要求用户级 OAuth 授权 | 用户 access/refresh token 加密存储在 `ConnectorConnection` |

管理员可配置加密固定请求头，例如内部 API Key 或服务令牌，而无需每个用户单独连接。固定请求头不会通过管理 API 回显；管理 API 只返回是否已配置以及请求头名称。OAuth 2.0 授权使用 `/api/connector-apps/{slug}/oauth/sessions` 和 `/api/connector-apps/oauth/callback`；用户凭据只加密存储在 `ConnectorConnection`，不会通过任何 API 返回。

过期但仍有 refresh token 的授权仍视为可用：运行时在下次访问上游前自动续期，对话引导不会误报"需要授权"；只有当 token 端点明确拒绝该 refresh token 时才会清除它，此时连接回到"需要授权"并由对话给出授权链接。

## 部署配置

生产部署必须保护项目通用敏感数据加密配置 `GIT_TOKEN_AES_KEY` 和 `GIT_TOKEN_AES_IV`。Connector Apps 使用现有 `encrypt_sensitive_data` 机制把固定请求头加密后写入 `Kind.json.spec.providerHeadersEncrypted`。密钥必须由密钥管理系统注入，不能提交到仓库；轮换密钥前需要制定现有加密字段的迁移方案。

```bash
GIT_TOKEN_AES_KEY="$(openssl rand -base64 24 | head -c 32)"
GIT_TOKEN_AES_IV="$(openssl rand -base64 12 | head -c 16)"
```

生产部署必须配置 `CONNECTOR_OAUTH_REDIRECT_URI`，其值必须与 DCR 注册的回调完全一致，例如 `https://wegent.example.com/api/connector-apps/oauth/callback`。生产环境应使用 HTTPS。内部 MCP 可以使用 HTTP，但只能由受信任管理员配置，并应由网络策略限制 Backend 的出站范围。

## 数据与生命周期

- Connector App 定义存储在 `kinds` 表中，`kind = "ConnectorApp"`，`namespace = "system"`，`metadata.name` 对应 app `slug`。
- App 可声明为 MCP 上游或 HTTP API 上游；主要配置位于 `Kind.json.spec`。
- 管理员固定请求头加密后存储在 `Kind.json.spec.providerHeadersEncrypted`。
- Connector App、用户连接和 OAuth 临时会话复用 `kinds` 表，分别使用 `ConnectorApp`、`ConnectorConnection` 和缓存中的短时会话，不引入新的物理表。
- 动态注册的 OAuth 客户端保存在 `Kind.json.spec.oauthClientEncrypted`。管理员在应用卡片上删除应用是物理删除：`ConnectorApp` 记录、该应用缓存的 OAuth 客户端以及所有用户的 `ConnectorConnection` 会一并移除，因此删除需要两次确认，且不可恢复。内置应用（钉钉文档、钉钉表格、钉钉 AI 表格、钉钉知识库）会在下一次后端启动时由种子逻辑自动补回；管理员手动创建的应用不会被补回。重新添加应用后，下一次授权会重新注册客户端。
- 最近一次成功发现的工具摘要按用户缓存在 `ConnectorConnection` 的 `toolSummaries` 中；多实例部署共享同一数据库，因此不存在实例本地缓存不一致。动态客户端注册使用共享分布式锁，避免多个实例并发重复注册。
- Connector 的出站请求忽略进程级代理设置。建立连接失败时会在连接层重试 2 次，只覆盖 DNS/TCP/TLS 握手，不会重放已经发出的请求；上游网关某个出口短暂返回无效证书时，重试会重新解析并连接其他出口。重试仍失败时，502 响应会区分为 TLS 证书校验失败、连接失败或超时，便于定位问题，其中鉴权类失败仍按未授权处理。
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
- `/api/mcp/connectors/sse`：面向 Chat Shell 的动态 MCP 端点。它按 task token 解析调用者，`tools/list` 只返回可见且在管理员白名单内的工具，`tools/call` 复用 `ConnectorRuntimeService`（用户 token、刷新、固定请求头、白名单校验）。不带 `X-Connector-App` 时只暴露 `static` App；带该请求头时只暴露对应 `lazy` App。后端仅在用户存在 `static` 已授权应用、且 Bot 使用 `Chat` Shell 时，把共享端点注入请求的 `mcp_servers`；`lazy` App 通过合成 Skill 延迟加载；编码类 Shell 继续使用设备本地的 `wegent_apps` 代理，避免工具重复暴露。

## 内置钉钉 Connector Apps

钉钉文档、表格、AI 表格、知识库由钉钉托管固定的 OAuth MCP 地址，用户不需要粘贴个人 URL。后端启动时（`CONNECTOR_BUILTIN_APPS_ENABLED=True`）会补齐缺失的应用定义：

| slug | 名称 | MCP 地址 |
| --- | --- | --- |
| `dingtalk_docs` | 钉钉文档 | `https://mcp-gw.dingtalk.com/oauth/server/doc` |
| `dingtalk_sheet` | 钉钉表格 | `https://mcp-gw.dingtalk.com/oauth/server/sheet` |
| `dingtalk_aitable` | 钉钉 AI 表格 | `https://mcp-gw.dingtalk.com/oauth/server/aitable` |
| `dingtalk_wiki` | 钉钉知识库 | `https://mcp-gw.dingtalk.com/oauth/server/wiki` |

补齐是幂等的：只要某个内置 slug 没有可用应用，就会新建一个。删除内置应用后，下一次启动会重新建出它；如需长期移除，请设置 `CONNECTOR_BUILTIN_APPS_ENABLED=False`。

这四个服务不再使用 provider 配置弹窗，也不再注入"打开配置弹窗"的引导。内置 App 默认使用 `toolLoadingMode: lazy`，并带有钉钉服务关键词；消息命中关键词时提前 preload 对应 `wegent-connector-<slug>` Skill，否则由模型按需 `load_skill`。未授权时仍由对话内的 Connector 授权链接引导。OAuth 授权、工具发现和白名单校验保持原有 Connector 流程不变。Wegent Web 的"设置 → 集成"不再展示钉钉 provider 卡片，改用"应用连接"卡片。

授权列表依赖当前这条消息（懒加载应用只有命中关键词才会出现），因此它被追加到当轮用户消息的 `<wegent_connector_apps>` 块中，而不是系统提示词：续跑的会话（Claude Code `--resume`、Codex thread）会保留首轮的系统提示词，否则列表会被固定在会话的第一条消息上。

**历史 API Key 配置保持兼容**：如果用户此前为这些服务保存过个人 Streamable HTTP 地址（形如 `https://mcp-gw.dingtalk.com/server/<token>?key=<key>`），运行时仍保留 Skill 的 `mcpServers` 占位符并在构建请求时沿用该地址，不会要求重新授权，对话引导也不会提示授权。只有没有个人地址时，工具才来自 Connector App；一旦该 Connector App 完成 OAuth 授权，则由它接管工具面，避免同一批工具重复暴露。

这个设计不使用 Codex 的原生 `codex_apps` Server。原生 Server 的 ChatGPT 认证和远端 App 目录属于 Codex 自身能力；Wegent 在 Executor 边界统一转换成标准 MCP，因此上游无论是 MCP 还是 HTTP API，都无需修改或登录 Codex。
