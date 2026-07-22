---
sidebar_position: 4
---

# 应用连接

Connector Apps 让管理员把内部 MCP 服务或 HTTP API 发布给 Wegent 智能体使用。当前版本不提供用户侧第三方授权入口；管理员发布对当前用户可见的应用后，Wework 连接到 Wegent 云端时会自动同步这些能力到本地 Codex。

## 管理员配置

1. 进入 Wegent Web 的 **系统管理 → 应用连接**。
2. 创建应用并填写唯一 `slug`、名称、描述和图标。工具会以 `<slug>__<tool>` 的形式出现在运行时中。
3. 选择连接协议：
   - **MCP**：填写 Streamable HTTP 或 SSE 端点。
   - **HTTP API**：填写 API 基础地址，并为每个工具配置 method、path、JSON Schema 和参数位置。
4. 选择认证方式。当前仅支持 **None**：适合不需要用户单独授权的内部系统，也可以配合管理员托管的固定请求头，例如内部 API Key 或服务令牌。
5. 设置可见范围和工具白名单。白名单会同时限制工具发现和工具调用。
6. 保存后可使用工具发现或测试入口验证配置。

固定请求头不会在管理 API 或页面中明文回显。编辑应用时留空会保留已加密的固定请求头，也可以显式清除后重新填写。

## 用户可见性

用户不需要在 Wegent 中单独连接 Connector App。Backend 会根据管理员配置的可见范围返回当前用户可用的应用：

- `visibility: all` 的应用对所有登录用户可见。
- `visibility: roles` 的应用只对 `allowed_roles` 中的角色可见。
- 停用应用后，它会从用户目录和运行时工具列表中消失。

## 在 Wework 中使用

Wework 连接 Wegent 云端后，会同步当前用户可见且可调用的 Connector Apps：

- Executor 注册本地 MCP Server `wegent_apps`。
- 每个应用会生成一个 Wegent 托管的本地 Skill。
- Codex 只能看到工具名称和 schema，不会接触管理员固定请求头。

如果云端连接断开，Wework 会移除 Connector 专用短期凭证、`wegent_apps` MCP 配置和自动生成的 Connector Skills。

## 数据与部署注意事项

Connector App 定义存储在 `kinds` 表中，使用 `kind = "ConnectorApp"`、`namespace = "system"`。管理员固定请求头会加密后写入 `Kind.json.spec.providerHeadersEncrypted`。

生产环境必须保护通用敏感数据加密密钥 `GIT_TOKEN_AES_KEY` 和 `GIT_TOKEN_AES_IV`，Connector Apps 使用项目现有的 `encrypt_sensitive_data` 机制加密固定请求头。当前版本不需要配置 OAuth callback URL。

更多架构、数据表和安全边界请参阅 [Connector Apps 架构与部署](../../developer-guide/connector-apps.md)。
