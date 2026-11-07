---
sidebar_position: 4
---

# 应用连接

Connector Apps 让管理员把 MCP 服务或 HTTP API 发布给 Wegent 智能体使用。应用需要 OAuth 时，用户可以在 Wegent Web 的“设置 → 集成”、Wework 的连接设置页或对话中的授权卡片完成授权。Wework 连接到 Wegent 云端后会同步这些能力到本地 Codex。

## 管理员配置

1. 进入 Wegent Web 的 **系统管理 → 应用连接**。
2. 创建应用并填写唯一 `slug`、名称、描述和图标。工具会以 `<slug>__<tool>` 的形式出现在运行时中。
3. 选择连接协议：
   - **MCP**：填写 Streamable HTTP 或 SSE 端点。
   - **HTTP API**：填写 API 基础地址，并为每个工具配置 method、path、JSON Schema 和参数位置。
4. 选择认证方式：**None** 适合无需用户单独授权的系统，可配合管理员托管的固定请求头；**OAuth 2.0** 使用标准 MCP OAuth 完成用户授权，可选填 scope。
5. 设置可见范围和工具白名单。白名单会同时限制工具发现和工具调用。
6. 选择按需加载（`lazy`）或静态加载（`static`），并配置用于对话命中的关键词。保存后可使用工具发现或测试入口验证配置；OAuth 应用需要先授权。

固定请求头不会在管理 API 或页面中明文回显。编辑应用时留空会保留已加密的固定请求头，也可以显式清除后重新填写。

## 用户可见性

Backend 根据管理员配置的可见范围返回应用；OAuth 授权只属于当前用户，不会共享给其他用户：

- `visibility: all` 的应用对所有登录用户可见。
- `visibility: roles` 的应用只对 `allowed_roles` 中的角色可见。
- 停用应用后，它会从用户目录和运行时工具列表中消失。
- 修改应用的 MCP 地址或认证方式后，旧连接会被移除，需要重新授权。

## 在 Wework 中使用

Wework 连接 Wegent 云端后，会同步当前用户可见且可调用的 Connector Apps：

- Executor 注册本地 MCP Server `wegent_apps`。
- 每个应用会生成一个 Wegent 托管的本地 Skill。
- Codex 只能看到工具名称和 schema，不会接触管理员固定请求头。
- 未授权应用通过授权卡片或连接设置页连接；授权完成后，等待本地能力同步再继续被中断的步骤。
- 过期连接可自动刷新；明确撤销的授权需要重新连接。临时上游故障或凭据解密配置错误不会被当作缺少授权。

如果云端连接断开，Wework 会移除 Connector 专用短期凭证、`wegent_apps` MCP 配置和自动生成的 Connector Skills。

## 数据与部署注意事项

Connector App 定义存储在 `kinds` 表中，使用 `kind = "ConnectorApp"`、`namespace = "system"`。管理员固定请求头会加密后写入 `Kind.json.spec.providerHeadersEncrypted`。

生产环境必须保护通用敏感数据加密密钥 `GIT_TOKEN_AES_KEY` 和 `GIT_TOKEN_AES_IV`，并为 OAuth 配置 `CONNECTOR_OAUTH_REDIRECT_URI`。固定请求头和用户 token 使用项目现有加密机制保存。

内置钉钉文档、表格、AI 表格和知识库默认开启，并使用按需加载。删除应用会物理移除定义及所有用户连接；内置应用在下次后端启动时补回，管理员停用的应用则保持停用。

更多架构、数据表和安全边界请参阅 [Connector Apps 架构与部署](../../developer-guide/connector-apps.md)。
