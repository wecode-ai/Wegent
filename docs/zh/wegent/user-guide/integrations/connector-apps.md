---
sidebar_position: 4
---

# 应用连接

Connector Apps 让管理员把内部 MCP 服务或 HTTP API 发布给 Wegent 智能体使用。用户只需要连接或授权自己可见的应用；Wework 连接到 Wegent 云端后，会自动同步这些能力到本地 Codex。

## 管理员配置

1. 进入 Wegent Web 的 **系统管理 → 应用连接**。
2. 创建应用并填写唯一 `slug`、名称、描述和图标。工具会以 `<slug>__<tool>` 的形式出现在运行时中。
3. 选择连接协议：
   - **MCP**：填写 Streamable HTTP 或 SSE 端点。
   - **HTTP API**：填写 API 基础地址，并为每个工具配置 method、path、JSON Schema 和参数位置。
4. 选择认证方式：
   - **None**：适合不需要用户身份的内部系统，也可以配合管理员托管的固定请求头。
   - **Bearer**：用户在 Wegent 中提交自己的访问令牌。
   - **OAuth 2.0**：用户从 Wegent 发起授权，Backend 保存加密 token。
5. 设置可见范围和工具白名单。白名单会同时限制工具发现和工具调用。
6. 保存后可使用工具发现或测试入口验证配置。

固定请求头、OAuth Client Secret 和用户凭据不会在管理 API 或页面中明文回显。修改 MCP 地址、认证类型或 OAuth 客户端配置会清除既有用户连接，用户需要重新授权。

## 用户连接

用户在可见应用列表中连接应用：

- `none` 类型应用通常会自动可用。
- `bearer` 类型应用需要提交个人访问令牌。
- `oauth2` 类型应用会打开第三方授权页面，完成后返回 Wegent。

断开连接只会删除 Wegent 中保存的连接记录，不会自动撤销第三方平台里的授权。需要彻底撤销时，请到第三方平台的账号安全或已授权应用页面处理。

## 在 Wework 中使用

Wework 连接 Wegent 云端后，会同步已连接且可调用的 Connector Apps：

- Executor 注册本地 MCP Server `wegent_apps`。
- 每个应用会生成一个 Wegent 托管的本地 Skill。
- Codex 只能看到工具名称和 schema，不会接触 OAuth token、Bearer token 或管理员固定请求头。

如果云端连接断开，Wework 会移除 Connector 专用短期凭证、`wegent_apps` MCP 配置和自动生成的 Connector Skills。

## 部署注意事项

生产环境必须设置独立的 `USER_AES_KEY`，用于加密 Connector 凭据。Backend 如果在反向代理后方，并且请求 Host 不是 OAuth Provider 可访问的公网地址，请设置 `CONNECTOR_OAUTH_CALLBACK_BASE_URL`，并把最终回调地址登记到 OAuth Provider。

更多架构、数据表和安全边界请参阅 [Connector Apps 架构与部署](../../developer-guide/connector-apps.md)。
