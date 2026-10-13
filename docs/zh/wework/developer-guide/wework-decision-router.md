---
sidebar_position: 66
---

# Wework 内置决策模型代理

Wework Smart App 有时需要调用专用决策模型（例如批量判定任务），而决策模型的请求协议既不是 Anthropic Messages，也不是 OpenAI Responses 或 Chat Completions。为此 Executor 内置一个本地决策路由：Smart App 只拿到 loopback 地址和一个不透明 route token，真实的决策服务凭证始终留在 Executor 内。

## 路由协议

路由在 Executor 本机 HTTP 服务上按 Smart App 实例注册，注册成功后 Smart App 通过环境变量拿到 loopback `baseUrl`、本地协议标识和协议版本：

```text
GET  /v1/decision-router/{token}/status                  # 默认模型与模型目录
POST /v1/decision-router/{token}/v1/decisions            # 决策请求
```

两个端点都要求 `Authorization: Bearer wework-local-router`。该值只是本机协议标识，真正的能力边界是不透明的 `{token}`。

请求体为 `{ "model": string, "state": any, "questions": object }`。`model` 原样转发，路由不维护模型白名单；`state` 不能为 `null`；`questions` 必须是非空对象。响应的顶层字段只保留 `model`、`request_id`、`answers`、`usage`、`latency_ms`。

决策上游固定为 `https://copilot.weibo.com/v1/decisions`，由 `WEWORK_DECISION_PROXY_UPSTREAM_URL` 指定并校验为 https 且路径精确等于 `/v1/decisions`；默认模型由 `WEWORK_DECISION_PROXY_DEFAULT_MODEL` 指定。Smart App 无法移动上游或模型目录。

## 上游凭证：登录态兑换

`copilot.weibo.com` 不认 Wework 登录 token。直接使用登录态调用 `/v1/decisions` 返回 401 `no valid apikey or auth information`，因为该服务只登记 Wegent 个人 API Key（`sk-wecode-…`）。因此 Executor 在每次转发前用当前登录态兑换一张模型 Key：

```text
ConnectionConfig.auth_token（Wework access token）
  → POST {backend_url}/api/internal/apikey/wegent-model-key
  → { "api_key": "sk-wecode-…" }
  → Authorization: Bearer sk-wecode-…  →  copilot.weibo.com/v1/decisions
```

兑换接口是「获取或创建」语义，不会每次轮换。同一个 Key 也能调用 `copilot.weibo.com/v1/responses` 等通用模型接口。

### 缓存与失效

- 兑换出的 Key 只缓存在 Executor 进程内存中，默认 TTL 10 分钟，按登录 token 的 SHA-256 指纹匹配；切换账号后指纹不匹配，下一次请求自动重新兑换。
- 缓存锁跨兑换持有，并发请求共用一次兑换，不会重复打后端。
- 上游返回 401 时丢弃缓存并重新兑换一次；仍然 401 则映射为 502 `upstream_rejected`。
- 兑换失败（网络、超时、非 2xx、响应体缺 `api_key`）返回 503 `credential_unavailable`（`retryable=true`），不会带着登录 token 直连上游。
- Key 不落盘、不进日志、不进响应，也不注入 Smart App 环境。

兑换地址复用 `ConnectionConfig.backend_url`：`{backend_url}/api/internal/apikey/wegent-model-key`；该地址若已以 `/api` 结尾则不重复拼接。仅接受 `http`/`https`，拒绝带 username 的地址。

## 生命周期

- Smart App 启动时通过 `runtime.decision_proxy.register` 注册 route，停止或删除时通过 `runtime.decision_proxy.unregister` 注销；注册和注销都以引用计数管理，同一 scope 重复注册只增加引用。
- 空闲 30 分钟的 route 会被回收，route 最长存活 24 小时。
- 未配置上游时路由仍然挂载，注册请求返回 `decision_router_disabled`；route 不存在返回 404 `route_not_found`。

## 安全边界

- 只有 loopback 地址暴露给 Smart App，真实凭证、上游地址与模型目录都不下发。
- 请求体的 Cookie、Origin、Referer、`x-forwarded-*` 和客户端自带 Authorization 一律不透传，只发送 Executor 自己生成的 `x-request-id` 和凭证。
- 请求体上限 1 MiB，问题数量上限 20，上游超时 30 秒。
- 日志记录 scope 的哈希、模型名、问题数量、状态码和耗时，不记录 `state`、`questions`、route token、登录 token 或模型 Key。
