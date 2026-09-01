---
sidebar_position: 20
---

# 外部 OAuth 2.0 接入指南

[English](../../../en/wegent/developer-guide/external-oauth-integration.md) | 简体中文

Wegent 提供一个受限的 OAuth 2.0 Authorization Code Provider，让外部应用在用户授权后读取当前 Wegent 用户的基础身份信息。

## 能力边界

| 项目          | 当前实现                        |
| ------------- | ------------------------------- |
| 授权模式      | Authorization Code + PKCE       |
| PKCE          | 仅 `S256`，所有 Client 必须使用 |
| Scope         | 仅 `userinfo.read`              |
| Access token  | RS256 JWT，最长 3600 秒         |
| Refresh token | 固定 30 天，成功轮换后重新计时  |
| Client 类型   | `public`、`confidential`        |
| 用户信息      | `id`、`user_name`、`email`      |

外部 access token 只能调用 OAuth `userinfo`，不能调用 Wegent 业务 API。当前实现不是 OpenID Connect，不提供 `openid` scope、ID Token、OIDC Discovery、Token Introspection 或动态 Client 注册。

## 公开端点

以下端点不需要 Wegent 登录或 Client 认证，这是 OAuth 客户端发现和 JWT 验签的标准入口：

```text
GET /.well-known/oauth-authorization-server/api
GET /api/external/oauth/jwks
```

其余端点由 Discovery 响应给出：

```text
GET  /api/external/oauth/authorize
POST /api/external/oauth/token
GET  /api/external/oauth/userinfo
POST /api/external/oauth/revoke
```

## 1. 创建 OAuth Client

应用开发者登录 Wegent 后，在 **设置 → 开发者凭据 → OAuth 应用** 中点击 **创建 OAuth 应用**。创建成功后，页面会返回该应用的 `client_id`；Confidential Client 还会一次性显示 `client_secret`。

创建第一个 OAuth Client 时，Backend 会自动创建并启用一套 Provider 级 SigningKey 和 TokenIssuer；后续 Client 复用这套签发配置。`TokenIssuer` 是 Wegent 内部的 JWT 签发配置，不是外部应用需要管理的对象。

每个开发者只能查看和维护自己创建的 Client。平台管理员可在 **管理后台 → 密钥管理 → OAuth 应用** 中进行全局查看、停用和删除，但不代替开发者创建应用，也不会看到 Client Secret。

在首个 Client 创建前，JWKS 返回以下内容是正常的：

```json
{ "keys": [] }
```

### Client 类型

| 类型           | 适用场景                                        | Token 端点认证                                                   |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `public`       | 桌面、移动端或 CLI 等无法安全保存 Secret 的应用 | 请求体发送 `client_id`，不使用 Secret                            |
| `confidential` | 有可信服务端、能够安全保存 Secret 的应用        | 推荐 HTTP Basic，也支持请求体发送 `client_id` 和 `client_secret` |

两种类型都必须使用 PKCE S256。

### 配置字段

- **应用名称**：帮助开发者和授权用户识别该 Client。
- **Redirect URI**：每行一个，回调时必须完全匹配，包括协议、域名、端口、路径和尾部斜杠。
- **Token 生命周期**：由 Provider 统一管理，Access token 为 3600 秒，Refresh token 为 30 天，应用不可单独修改。
- **Client Secret**：仅 Confidential Client 存在，只在创建或轮换后显示一次。

生产环境使用 HTTPS Redirect URI；本地调试可以登记明确的 loopback 地址，例如：

```text
http://127.0.0.1:8765/callback
```

## 2. 读取 Authorization Server Metadata

本地环境：

```bash
curl http://localhost:8000/.well-known/oauth-authorization-server/api
```

响应示例：

```json
{
  "issuer": "http://localhost:8000/api",
  "authorization_endpoint": "http://localhost:8000/api/external/oauth/authorize",
  "token_endpoint": "http://localhost:8000/api/external/oauth/token",
  "revocation_endpoint": "http://localhost:8000/api/external/oauth/revoke",
  "jwks_uri": "http://localhost:8000/api/external/oauth/jwks",
  "userinfo_endpoint": "http://localhost:8000/api/external/oauth/userinfo",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["userinfo.read"]
}
```

Client 应以 Discovery 响应为准，不要自行拼接 Provider 端点。

## 3. 发起授权

先生成一次性的 `state`、PKCE `code_verifier` 和 `code_challenge`：

```python
import base64
import hashlib
import secrets

state = secrets.token_urlsafe(32)
code_verifier = secrets.token_urlsafe(64)
code_challenge = base64.urlsafe_b64encode(
    hashlib.sha256(code_verifier.encode("ascii")).digest()
).rstrip(b"=").decode("ascii")
```

让用户浏览器打开 Discovery 返回的 `authorization_endpoint`：

```text
GET {authorization_endpoint}
  ?response_type=code
  &client_id={client_id}
  &redirect_uri={url_encoded_redirect_uri}
  &scope=userinfo.read
  &state={state}
  &code_challenge={code_challenge}
  &code_challenge_method=S256
```

用户需要先登录 Wegent，然后在授权页确认应用名称、权限和 Redirect URI。

授权成功后，浏览器跳转至已登记的 Redirect URI：

```text
{redirect_uri}?code={authorization_code}&state={state}&iss={issuer}
```

Client 必须：

1. 校验返回的 `state` 与本地保存值完全一致。
2. 校验 `iss` 与 Discovery 中的 `issuer` 完全一致。
3. 立即使用授权码，不要记录或重复使用；授权码有效期为 5 分钟且只能消费一次。

用户拒绝授权时，回调包含 `error=access_denied`。只有 Client 和 Redirect URI 都通过服务端校验后，授权错误才会重定向到外部应用。

## 4. 用授权码换取 Token

Token 请求必须使用 `application/x-www-form-urlencoded`，并提交创建授权请求时使用的同一个 Redirect URI 和 PKCE verifier。

Confidential Client 推荐使用 HTTP Basic：

```bash
curl -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "code=${AUTHORIZATION_CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}" \
  "${TOKEN_ENDPOINT}"
```

Public Client 不发送 Secret：

```bash
curl \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "code=${AUTHORIZATION_CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}" \
  "${TOKEN_ENDPOINT}"
```

成功响应：

```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<opaque token>",
  "scope": "userinfo.read"
}
```

## 5. 获取用户信息

```bash
curl \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${USERINFO_ENDPOINT}"
```

响应：

```json
{
  "id": 123,
  "user_name": "example",
  "email": "example@example.com"
}
```

不要把这个 access token 发送到其他 Wegent API；业务 API 会拒绝它。

## 6. 刷新 Token

Access token 过期前后都可以使用当前 refresh token 获取新 token 对。Confidential Client 示例：

```bash
curl -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "refresh_token=${REFRESH_TOKEN}" \
  "${TOKEN_ENDPOINT}"
```

Public Client 在请求体中发送 `client_id`，不发送 Secret。

每次刷新都会返回一个新的 refresh token，并立即使旧 refresh token 失效。Client 必须原子替换本地保存的 token 对，并保证同一登录会话内的刷新请求串行执行。

如果旧 refresh token 被再次使用，Wegent 会判定为重放并撤销该 token family，之后最新的 refresh token 也会失效，用户必须重新授权。

Refresh token 默认有效期为 30 天，但采用滑动轮换：每次成功刷新后，新 refresh token 都从刷新时刻重新获得完整的配置有效期。因此，只要应用在当前 refresh token 过期前正常轮换，用户不需要固定每 30 天重新授权。

出现以下情况时必须重新走授权码流程：

- refresh token 已过期、被撤销或发生重放；
- OAuth Client 被禁用或删除；
- Client 类型发生变化；
- Confidential Client 的 Secret 被轮换；
- 用户或 Provider 签发配置失效。

## 7. 撤销 Refresh Token

退出登录时撤销 refresh token：

```bash
curl -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "token=${REFRESH_TOKEN}" \
  --data-urlencode 'token_type_hint=refresh_token' \
  "${REVOCATION_ENDPOINT}"
```

Public Client 在请求体中增加 `client_id`，不使用 HTTP Basic。

撤销会使整个 refresh token family 失效。未知 token 仍返回 HTTP 200；access token 不支持主动撤销，会在最多 3600 秒后自然过期。无论撤销响应如何，Client 都应删除本地 token。

## JWT 与 JWKS

调用 `userinfo` 时不需要 Client 自行解析 JWT。如果外部系统还需要本地审计 access token，应从 Discovery 的 `jwks_uri` 读取公钥，并至少校验：

- JWT header：`alg=RS256`、`typ=at+jwt`、有效 `kid`；
- claims：`iss`、`sub`、`aud`、`exp`、`iat`、`jti`；
- `aud=wegent-userinfo`；
- `scope=userinfo.read`；
- `client_id` 等于当前 Client。

不要把未验签的 claims 当作可信用户信息。

## 错误处理

Token、userinfo 和撤销端点使用标准 OAuth 错误结构：

```json
{
  "error": "invalid_grant",
  "error_description": "Invalid or expired code"
}
```

| 错误                      | Client 行为                                     |
| ------------------------- | ----------------------------------------------- |
| `invalid_request`         | 检查参数、重复的 Client 认证方式和 Content-Type |
| `invalid_client`          | 检查 Client 状态、ID 和 Secret；不要自动重试    |
| `invalid_grant`           | 授权码或 refresh token 已失效，重新授权         |
| `invalid_scope`           | 仅请求 `userinfo.read`                          |
| `invalid_token`           | access token 无效或过期，刷新后重试一次         |
| `temporarily_unavailable` | Provider 暂时不可用，使用退避策略重试           |

同一请求不能同时使用 HTTP Basic 和请求体 Secret。

## 安全检查清单

- 生产环境只使用 HTTPS Provider 和 Redirect URI。
- 每次授权生成新的 `state` 和 PKCE verifier，并验证回调 `state`、`iss`。
- Redirect URI 使用固定白名单，不接受用户临时输入。
- Client Secret 只保存在可信服务端，不进入浏览器包、URL、日志或代码仓库。
- access token、refresh token 和授权码不写入日志。
- refresh token 使用安全存储，并串行、原子地完成轮换。
- 收到 `invalid_grant` 时停止循环刷新，要求用户重新授权。

内部实现与安全不变量见[外部 OAuth 身份令牌架构](../../architecture/external-oauth-provider.md)。
