---
sidebar_position: 66
---

# Wework Built-in Decision Model Proxy

Wework Smart Apps sometimes need a dedicated decision model (for example batch judging tasks), and the decision wire protocol is neither Anthropic Messages nor OpenAI Responses or Chat Completions. The Executor therefore serves a local decision router: a Smart App receives only a loopback address and an opaque route token, while the real upstream credential stays inside the Executor.

## Router Protocol

Routes are registered per Smart App instance on the Executor's loopback HTTP server. After registration the Smart App receives the loopback `baseUrl`, the local protocol marker, and the protocol version through environment variables:

```text
GET  /v1/decision-router/{token}/status                  # default model and model catalogue
POST /v1/decision-router/{token}/v1/decisions            # decision request
```

Both endpoints require `Authorization: Bearer wework-local-router`. That value is only a local protocol marker; the opaque `{token}` is the capability.

The request body is `{ "model": string, "state": any, "questions": object }`. `model` is forwarded verbatim because the router keeps no allowlist; `state` must not be `null`; `questions` must be a non-empty object. Only `model`, `request_id`, `answers`, `usage`, and `latency_ms` survive in the response.

The decision upstream is fixed to `https://copilot.weibo.com/v1/decisions`, selected by `WEWORK_DECISION_PROXY_UPSTREAM_URL` and validated as https with a path of exactly `/v1/decisions`; the default model comes from `WEWORK_DECISION_PROXY_DEFAULT_MODEL`. A Smart App cannot move the upstream or the catalogue.

## Upstream Credential: Login-State Exchange

`copilot.weibo.com` does not accept the Wework login token. Calling `/v1/decisions` with the login state returns 401 `no valid apikey or auth information`, because that service only knows Wegent personal API keys (`sk-wecode-…`). The Executor therefore trades the current login state for a model key before every forward:

```text
ConnectionConfig.auth_token (Wework access token)
  → POST {backend_url}/api/internal/apikey/wegent-model-key
  → { "api_key": "sk-wecode-…" }
  → Authorization: Bearer sk-wecode-…  →  copilot.weibo.com/v1/decisions
```

The exchange is a get-or-create call, so it does not rotate the key on every request. The same key also works for general model endpoints such as `copilot.weibo.com/v1/responses`.

### Caching and Invalidation

- The exchanged key lives in Executor process memory only, with a 10 minute TTL keyed by the SHA-256 fingerprint of the login token. After an account switch the fingerprint no longer matches and the next request trades again.
- The cache lock is held across the exchange, so concurrent requests share one trade instead of hitting the backend repeatedly.
- A 401 from the upstream drops the cached key and trades once more; a second 401 maps to 502 `upstream_rejected`.
- A failed exchange (network, timeout, non-2xx, missing `api_key`) answers 503 `credential_unavailable` (`retryable=true`) instead of calling the upstream with the login token.
- The key is never written to disk, never logged, never returned in a response, and never injected into the Smart App environment.

The exchange URL reuses `ConnectionConfig.backend_url`: `{backend_url}/api/internal/apikey/wegent-model-key`, and a trailing `/api` is not duplicated. Only `http`/`https` are accepted, and URLs carrying a username are rejected.

## Lifecycle

- A Smart App registers a route through `runtime.decision_proxy.register` on start and releases it through `runtime.decision_proxy.unregister` on stop or delete; registration is reference counted, so re-registering the same scope only adds a reference.
- Idle routes are reclaimed after 30 minutes and no route lives longer than 24 hours.
- Routes stay mounted when the deployment has no usable upstream: registration then answers `decision_router_disabled`, and an unknown route answers 404 `route_not_found`.

## Security Boundary

- Only the loopback address reaches the Smart App; the real credential, upstream URL, and catalogue never do.
- Cookie, Origin, Referer, `x-forwarded-*`, and a client-supplied Authorization header are never forwarded. Only the Executor's own `x-request-id` and credential travel upstream.
- Request bodies are capped at 1 MiB, questions at 20, and the upstream timeout is 30 seconds.
- Logs carry the scope hash, model name, question count, status, and duration; never `state`, `questions`, the route token, the login token, or the model key.
