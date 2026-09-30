---
sidebar_position: 21
---

# MCP Access Tokens (Simplified OAuth)

English | [简体中文](../../../zh/wegent/developer-guide/mcp-token.md)

A business MCP server only needs to know *who* is calling. Reusing the task
token would expose the whole task scope for 24 hours, so Wegent mints a
dedicated token instead: short-lived, bound to an audience, and limited to the
scopes the caller asked for.

The flow is a minimal OAuth 2.0 deployment — no consent page, no PKCE, no
refresh token, just "get a token, validate a token, read the user".

## Capabilities

| Item          | Current implementation                                          |
| ------------- | --------------------------------------------------------------- |
| Acquisition   | Exchange an existing Wegent credential; no second user consent   |
| Token type    | HS256 JWT with `type=mcp_token`                                  |
| Audience      | Fixed `aud=wegent-mcp`                                           |
| Scope         | Only `mcp:userinfo.read`                                         |
| Lifetime      | Fixed 60 minutes, provider-managed and not caller-configurable   |
| Refresh token | Not supported; exchange again after expiry                       |
| Reachable API | Only the `mcp` identity endpoints, never Wegent business APIs    |

## Public endpoints

```text
POST /api/external/mcp/token       # exchange a credential for a token
POST /api/external/mcp/introspect  # validate a token
GET  /api/external/mcp/userinfo    # read the user behind a token
```

### 1. Exchange a credential for a token

`POST /api/external/mcp/token` accepts any existing Wegent credential:

| Credential              | Use case                                              |
| ----------------------- | ----------------------------------------------------- |
| User session JWT        | A service acting on behalf of a signed-in user         |
| Personal API key (`wg-`) | Long-running integrations                             |
| Task token              | An MCP server trading in the `${{task_token}}` it got |

The body carries only `scope`, defaulting to `mcp:userinfo.read`:

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

An unsupported scope is rejected with 400 instead of being silently dropped,
so a caller never ends up with fewer permissions than it believes it has.

### 2. Validate a token

`POST /api/external/mcp/introspect` is an RFC 7662 subset. It takes a
form-encoded token and needs no Wegent login:

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

Invalid or expired tokens answer `{"active": false}` with HTTP 200, so a
server can treat every failure the same way.

### 3. Read the user

`GET /api/external/mcp/userinfo` takes the same token as a Bearer credential
and returns the caller's basic information (`id`, `user_name`, `email`) plus
the scopes actually granted. The response never contains git credentials.

## Injecting the token into a business MCP server

Wegent writes the MCP token of the current execution into the execution
request, so a Ghost can reference it with the `${{mcp_token}}` placeholder in
`mcpServers.headers`:

```yaml
spec:
  mcpServers:
    business:
      type: streamable-http
      url: https://mcp.business.example.com/mcp
      headers:
        Authorization: "Bearer ${{mcp_token}}"
```

The business side can then validate the token with
`POST /api/external/mcp/introspect`, or resolve the user with
`GET /api/external/mcp/userinfo`. Integrations that still need task identity
can keep using `${{task_token}}` (see the
[Ghost YAML specification](../reference/yaml-specification.md)).

## How it relates to the other tokens

| Token             | Audience and scope         | Lifetime | Use case                                    |
| ----------------- | -------------------------- | -------- | ------------------------------------------- |
| MCP token         | `wegent-mcp`, read identity | 60 min   | Business MCP servers identifying the caller |
| Task token        | No audience, task identity  | 24 hours | Executor calling back into Wegent APIs      |
| Skill identity    | No audience, runtime identity | 10 days | Skill calling business HTTP APIs           |
| Internal service  | Shared static secret           | Never    | Wegent services calling each other          |

Issuance and validation live in `backend/app/services/auth/mcp_token.py`; the
HTTP endpoints live in `backend/app/api/endpoints/mcp_token.py`.
