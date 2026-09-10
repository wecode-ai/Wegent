---
sidebar_position: 14
---

# 插件远程 MCP 的 TaskToken

Wework 插件可使用现有 Wegent TaskToken 识别当前用户和任务，无需用户复制登录凭证。
在插件的 `mcpServers` 声明或 `.mcp.json` 中配置：

```json
{
  "business": {
    "type": "http",
    "url": "https://business.example/mcp",
    "headers": {
      "Authorization": "Bearer ${{task_token}}"
    }
  }
}
```

本机和远程 Executor 使用已认证、已注册的设备连接向后端请求 Token。用户和设备身份来自该连接，插件不能通过请求字段覆盖。TaskToken 沿用现有签名、验签及 24 小时有效期，不使用用户登录 Token 或无任务绑定的 runtime Token 替代。

## 业务服务校验

业务 MCP 将收到的 Bearer Token 原样转交给签发它的 Wegent 后端：

```http
GET /api/external/mcp-identity/userinfo
Authorization: Bearer <received-task-token>
```

验证通过后，原有 `id`、`user_name`、`email` 字段保持不变，新增 `task`：

```json
{
  "id": 42,
  "user_name": "alice",
  "email": "alice@example.com",
  "task": {
    "kind": "runtime",
    "id": "runtime-example-task",
    "device_id": "app-record-123"
  }
}
```

业务授权应使用完整的 `(id, task.kind, task.device_id, task.id)`，不能只比较本地任务 ID，也不能未经验签就相信 JWT 内容。同一设备上的同一任务在续聊、重启及续签后保持身份；新建和分叉任务获得不同身份。迁移到不同设备的任务属于不同设备的任务地址。

已有 Wegent CRD 任务返回 `task.kind = "wegent"` 和字符串形式的任务 ID；没有具体任务绑定的旧 runtime Token 返回 `task = null`。需要任务权限的业务服务应拒绝 `task = null`。业务资源的授权规则仍由业务 MCP 管理，身份校验本身不授予操作权限。

## 执行和凭证生命周期

- 仅代理声明 `${{task_token}}` 的插件远程 MCP；普通 MCP 和本地脚本不通过这条能力获取 Token。
- 真实 Token 只保留在 Executor 内存，出站请求时加入 Header，并在临近过期时续签。插件源 MCP 声明和共享能力清单不保存真实 Token。
- 原生运行时使用任务专属的 loopback MCP 地址。Claude 使用执行专属临时配置；Codex 续聊时更新会话配置。任务结束后关闭该入口。
- 原生插件缓存中的 manifest 和 Claude 自动加载的 `.mcp.json` 会过滤掉由 Executor 接管的服务，以避免重复加载；缓存内保留带占位符的原始声明，源插件包不变。插件其他组件照常由原生运行时加载。此功能要求使用实际复制的插件缓存，不修改指向源目录的符号链接。
- 未登录、签发失败或连接被替换时明确失败，不降级为其他凭证。不会自动跟随携带 Token 的服务重定向。

部署时先更新后端，再更新 Executor/桌面。无需数据库迁移。桌面回归位于现有 `plugin-task-token` checkpoint，覆盖 Claude/Codex、本机/远程、续聊身份和业务按任务拒绝访问。
