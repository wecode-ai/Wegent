---
sidebar_position: 21
---

# MCP 访问令牌（简化版 OAuth）

[English](../../../en/wegent/developer-guide/mcp-token.md) | 简体中文

业务方 MCP 服务器只需要知道“是谁在调用”。直接复用任务 token 会把整个任务范围暴露 24 小时，因此 Wegent 签发一个专用令牌：短有效期、绑定受众、只包含调用方申请的 scope。

整套流程是 OAuth 2.0 的精简形态——没有授权页、没有 PKCE、没有 refresh token，只保留“取令牌 → 校验令牌 → 读取用户信息”三步。

## 能力边界

| 项目          | 当前实现                                          |
| ------------- | ------------------------------------------------- |
| 获取方式      | 用已有 Wegent 凭据换取，无需用户再次授权          |
| 令牌类型      | HS256 JWT，`type=mcp_token`                        |
| 受众          | 固定 `aud=wegent-mcp`                              |
| Scope         | 仅 `mcp:userinfo.read`                             |
| 有效期        | 固定 60 分钟，由 Provider 统一管理，调用方不可修改 |
| Refresh token | 不支持，过期后重新换取                             |
| 可调用 API    | 仅 `mcp` 身份接口，不能调用 Wegent 业务 API        |

## 公开端点

```text
POST /api/external/mcp/token       # 换取令牌
POST /api/external/mcp/introspect  # 校验令牌
GET  /api/external/mcp/userinfo    # 读取用户信息
```

### 1. 换取令牌

`POST /api/external/mcp/token` 需要携带一个已有的 Wegent 凭据，三种都接受：

| 凭据                  | 使用场景                                     |
| --------------------- | -------------------------------------------- |
| 用户会话 JWT          | 服务端代表用户申请                           |
| 个人 API Key（`wg-`） | 长期运行的集成                               |
| 任务 token            | MCP 服务器把手上的 `${{task_token}}` 拿来换 |

请求体只有 `scope`，省略时默认为 `mcp:userinfo.read`：

```bash
curl -X POST https://wegent.example.com/api/external/mcp/token \
  -H "Authorization: Bearer $WEGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scope": "mcp:userinfo.read"}'
```

```json
{
  "access_token": "<mcp token>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "mcp:userinfo.read"
}
```

申请未支持的 scope 会返回 400，而不是静默降级，调用方不会在不知情的情况下少拿到权限。

### 2. 校验令牌

`POST /api/external/mcp/introspect` 是 RFC 7662 的子集，使用表单编码提交令牌，不需要 Wegent 登录：

```bash
curl -X POST https://wegent.example.com/api/external/mcp/introspect \
  -d "token=$MCP_TOKEN"
```

```json
{
  "active": true,
  "scope": "mcp:userinfo.read",
  "sub": "alice",
  "username": "alice",
  "user_id": 7,
  "aud": "wegent-mcp",
  "token_type": "mcp_token",
  "jti": "0f9c…",
  "iat": 1789000000,
  "exp": 1789003600,
  "task_id": 12,
  "subtask_id": 34
}
```

无效或已过期的令牌返回 `{"active": false}` 与 HTTP 200，服务器可以用同一段逻辑处理所有失败情况。

### 3. 读取用户信息

`GET /api/external/mcp/userinfo` 用同一个令牌作为 Bearer 凭据，返回调用用户的基础信息（`id`、`user_name`、`email`）以及实际授予的 scope。响应不包含 git 凭据。

## 注入到业务方 MCP 服务器

Wegent 在构造请求时会把当前执行的 MCP 令牌写入执行请求，Ghost 的 `mcpServers.headers` 里配置 `${{mcp_token}}` 占位符即可：

```yaml
spec:
  mcpServers:
    business:
      type: streamable-http
      url: https://mcp.business.example.com/mcp
      headers:
        Authorization: "Bearer ${{mcp_token}}"
```

业务方收到请求后，可以直接用 `POST /api/external/mcp/introspect` 校验，或用 `GET /api/external/mcp/userinfo` 解析用户。需要任务维度信息时，仍可使用 `${{task_token}}`（见 [Ghost YAML 规范](../reference/yaml-specification.md)）。

## 与其它令牌的关系

| 令牌              | 受众与 Scope            | 有效期 | 适用场景                         |
| ----------------- | ----------------------- | ------ | -------------------------------- |
| MCP 令牌          | `wegent-mcp`，仅身份读取 | 60 分钟 | 业务方 MCP 服务器识别调用用户    |
| 任务 token        | 无受众，携带任务身份     | 24 小时 | Executor 回调 Wegent 业务接口    |
| Skill 身份 token  | 无受众，携带运行时身份   | 10 天   | Skill 回调业务 HTTP 接口         |
| 内部服务 token    | 共享静态密钥             | 不失效  | Wegent 内部服务之间调用          |

签发与校验的实现位于 `backend/app/services/auth/mcp_token.py`，HTTP 端点位于 `backend/app/api/endpoints/mcp_token.py`。
