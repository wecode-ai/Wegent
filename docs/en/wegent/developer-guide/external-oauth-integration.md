---
sidebar_position: 20
---

# External OAuth 2.0 Integration

English | [简体中文](../../../zh/wegent/developer-guide/external-oauth-integration.md)

Wegent provides a constrained OAuth 2.0 Authorization Code Provider that lets an external application read the current Wegent user's basic identity after consent.

## Capability Boundary

| Item               | Current implementation                               |
| ------------------ | ---------------------------------------------------- |
| Authorization flow | Authorization Code with PKCE                         |
| PKCE               | `S256` only, required for every client               |
| Scope              | `userinfo.read` only                                 |
| Access token       | RS256 JWT, maximum 3600 seconds                      |
| Refresh token      | Fixed at 30 days and reset after successful rotation |
| Client types       | `public`, `confidential`                             |
| User information   | `id`, `user_name`, `email`                           |

An external access token can call only OAuth `userinfo`; it cannot call Wegent business APIs. The current implementation is not OpenID Connect and does not provide the `openid` scope, ID Tokens, OIDC Discovery, Token Introspection, or dynamic client registration.

## Public Endpoints

The following endpoints intentionally require neither Wegent login nor client authentication. They are the standard entry points for client discovery and JWT verification:

```text
GET /.well-known/oauth-authorization-server/api
GET /api/external/oauth/jwks
```

Discovery publishes the remaining endpoints:

```text
GET  /api/external/oauth/authorize
POST /api/external/oauth/token
GET  /api/external/oauth/userinfo
POST /api/external/oauth/revoke
```

## 1. Create an OAuth Client

After signing in to Wegent, the application developer selects **Settings → Developer Credentials → OAuth Apps → Create OAuth App**. The page returns the app's `client_id`; a confidential client also receives a one-time `client_secret`.

When the first OAuth Client is created, Backend automatically creates and enables a provider-level SigningKey and TokenIssuer. Later clients reuse that signing configuration. `TokenIssuer` is an internal Wegent JWT configuration, not an object that external applications need to manage.

Developers can view and maintain only their own clients. Platform administrators can globally review, disable, or delete clients under **Administration → API Keys → OAuth Apps**, but they do not create apps on behalf of developers or see client secrets.

Before the first client is created, this JWKS response is expected:

```json
{ "keys": [] }
```

### Client Types

| Type           | Use case                                                       | Token endpoint authentication                                                              |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `public`       | Desktop, mobile, or CLI applications that cannot keep a secret | Send `client_id` in the request body; do not use a secret                                  |
| `confidential` | Applications with a trusted backend that can protect a secret  | HTTP Basic is recommended; request-body `client_id` and `client_secret` are also supported |

Both client types must use PKCE S256.

### Configuration

- **Application name**: identifies the client to its developer and consenting users.
- **Redirect URI**: one per line; the callback must match the registered value exactly, including scheme, host, port, path, and trailing slash.
- **Token lifetime**: managed by the provider. Access tokens last 3600 seconds and refresh tokens last 30 days; applications cannot override these values.
- **Client Secret**: exists only for confidential clients and is shown once after creation or rotation.

Use HTTPS redirect URIs in production. A fixed loopback URI is suitable for local testing:

```text
http://127.0.0.1:8765/callback
```

## 2. Read Authorization Server Metadata

Local environment:

```bash
curl http://localhost:8000/.well-known/oauth-authorization-server/api
```

Example response:

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

Use the endpoints returned by Discovery instead of constructing provider URLs in the client.

## 3. Start Authorization

Generate a one-time `state`, PKCE `code_verifier`, and `code_challenge`:

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

Open the Discovery `authorization_endpoint` in the user's browser:

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

The user signs in to Wegent if necessary, then reviews the application name, permission, and redirect URI on the consent page.

After approval, the browser returns to the registered redirect URI:

```text
{redirect_uri}?code={authorization_code}&state={state}&iss={issuer}
```

The client must:

1. Verify that the returned `state` exactly matches its stored value.
2. Verify that `iss` exactly matches the Discovery `issuer`.
3. Exchange the code immediately without logging or reusing it. An authorization code expires after five minutes and can be consumed only once.

If the user denies consent, the callback contains `error=access_denied`. Wegent redirects authorization errors to an external application only after validating both the client and redirect URI.

## 4. Exchange the Authorization Code

The token request must use `application/x-www-form-urlencoded` and submit the same redirect URI and PKCE verifier used for the authorization request.

HTTP Basic is recommended for a confidential client:

```bash
curl -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode "code=${AUTHORIZATION_CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}" \
  "${TOKEN_ENDPOINT}"
```

A public client does not send a secret:

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

Successful response:

```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<opaque token>",
  "scope": "userinfo.read"
}
```

## 5. Read User Information

```bash
curl \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${USERINFO_ENDPOINT}"
```

Response:

```json
{
  "id": 123,
  "user_name": "example",
  "email": "example@example.com"
}
```

Do not send this access token to other Wegent endpoints; business APIs reject it.

## 6. Refresh Tokens

Use the current refresh token to obtain a new token pair before or after the access token expires. Confidential client example:

```bash
curl -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "refresh_token=${REFRESH_TOKEN}" \
  "${TOKEN_ENDPOINT}"
```

A public client sends `client_id` in the request body and does not send a secret.

Every refresh returns a new refresh token and immediately invalidates the previous one. The client must atomically replace its stored token pair and serialize refresh requests within the same login session.

If an old refresh token is used again, Wegent treats it as replay and revokes the token family. The newest refresh token then also becomes invalid, and the user must authorize again.

The default refresh-token lifetime is 30 days, with sliding rotation: each successful refresh gives the replacement refresh token the full configured lifetime from that refresh time. A user therefore does not need to authorize every 30 days as long as the application rotates the current refresh token before it expires.

Run the authorization-code flow again when:

- the refresh token expires, is revoked, or is replayed;
- the OAuth Client is disabled or deleted;
- the client type changes;
- a confidential client's secret is rotated;
- the user or provider signing configuration becomes inactive.

## 7. Revoke a Refresh Token

Revoke the refresh token during logout:

```bash
curl -u "${CLIENT_ID}:${CLIENT_SECRET}" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "token=${REFRESH_TOKEN}" \
  --data-urlencode 'token_type_hint=refresh_token' \
  "${REVOCATION_ENDPOINT}"
```

A public client adds `client_id` to the request body and does not use HTTP Basic.

Revocation invalidates the entire refresh-token family. An unknown token still returns HTTP 200. Access-token revocation is not supported; an access token expires naturally after at most 3600 seconds. Delete local tokens regardless of the revocation response.

## JWT and JWKS

A client calling `userinfo` does not need to parse the JWT itself. If an external service also audits the access token locally, read public keys from the Discovery `jwks_uri` and validate at least:

- JWT header: `alg=RS256`, `typ=at+jwt`, and a valid `kid`;
- claims: `iss`, `sub`, `aud`, `exp`, `iat`, and `jti`;
- `aud=wegent-userinfo`;
- `scope=userinfo.read`;
- `client_id` equals the current client.

Never trust claims from an unverified token.

## Error Handling

The token, userinfo, and revocation endpoints use the standard OAuth error shape:

```json
{
  "error": "invalid_grant",
  "error_description": "Invalid or expired code"
}
```

| Error                     | Client behavior                                                             |
| ------------------------- | --------------------------------------------------------------------------- |
| `invalid_request`         | Check parameters, duplicate client authentication methods, and Content-Type |
| `invalid_client`          | Check client status, ID, and secret; do not retry automatically             |
| `invalid_grant`           | The code or refresh token is inactive; authorize again                      |
| `invalid_scope`           | Request only `userinfo.read`                                                |
| `invalid_token`           | The access token is invalid or expired; refresh and retry once              |
| `temporarily_unavailable` | Retry with backoff                                                          |

Do not use HTTP Basic and a request-body secret in the same request.

## Security Checklist

- Use HTTPS provider and redirect URIs in production.
- Generate a new `state` and PKCE verifier for every authorization request, then verify callback `state` and `iss`.
- Use a fixed redirect-URI allowlist; do not accept arbitrary user input.
- Keep a client secret only on a trusted backend, never in a browser bundle, URL, log, or source repository.
- Do not log access tokens, refresh tokens, authorization codes, or client secrets.
- Store refresh tokens securely and rotate them serially and atomically.
- Stop refresh loops on `invalid_grant` and require the user to authorize again.

See [External OAuth identity token architecture](../../architecture/external-oauth-provider.md) for internal implementation and security invariants.
