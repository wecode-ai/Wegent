---
sidebar_position: 17
---

# External OAuth identity tokens

## Scope

Wegent acts as a constrained OAuth 2 authorization server that proves the current user's identity to registered external clients. External access tokens may read only the dedicated userinfo resource and grant no Wegent API or downstream business permissions.

See the [External OAuth 2.0 Integration Guide](../wegent/developer-guide/external-oauth-integration.md) for client registration, PKCE, token exchange, refresh, and revocation.

## Connection graph

```mermaid
flowchart LR
    Developer[Application developer] -->|Manage owned clients after login| ClientAPI[Self-service OAuth Client API]
    Admin[Platform administrator] -->|List / disable / delete globally| AdminClientAPI[OAuth Client governance API]
    ClientAPI --> Kinds
    AdminClientAPI --> Kinds
    Client[External OAuth Client] -->|authorize + PKCE| OAuthAPI[OAuth API]
    OAuthAPI --> Consent[Wegent Web consent page]
    Consent -->|Wegent login JWT| SessionAuth[Existing Wegent auth]
    Consent -->|approve| OAuthAPI
    OAuthAPI --> Redis[(Redis requests and codes)]
    OAuthAPI --> TokenService[OAuth Provider Service]
    TokenService --> Kinds[(OAuthClient / TokenIssuer / SigningKey Kinds)]
    TokenService --> Refresh[(OAuth refresh-token table)]
    Client -->|RFC 8414 discovery| Metadata[Authorization server metadata]
    Client -->|fetch verification keys| JWKS[OAuth JWKS]
    Client -->|external access token| UserInfo[OAuth userinfo]
    UserInfo --> ExternalAuth[Dedicated external-token verifier]
    ExternalAuth --> Users[(users)]
    Client -. external token must fail .-> WegentAPI[Wegent business APIs]
    WegentAPI --> SessionAuth
```

## Provider initialization sequence

```mermaid
sequenceDiagram
    participant D as Application developer
    participant O as Self-service OAuth Client API
    participant T as Outbound Token Service
    participant DB as Database

    D->>O: Create an owned OAuth Client after login
    O->>T: Resolve provider-level TokenIssuer
    T->>DB: Find active issuer matching issuer + audience
    alt Existing issuer
        T->>DB: Normalize TTL policy to 3600 seconds
    else Missing issuer
        T->>DB: Create SigningKey + TokenIssuer (maximum TTL 3600 seconds)
    end
    T-->>O: Return shared TokenIssuer id
    O->>DB: Create OAuthClient with the developer user_id
    O-->>D: client_id + one-time client_secret
```

## Authorization-code sequence

```mermaid
sequenceDiagram
    participant C as External Client
    participant O as OAuth API
    participant W as Wegent Web
    participant R as Redis
    participant D as Database

    C->>O: GET /external/oauth/authorize + state + PKCE
    O->>D: Validate client, redirect URI, and TokenIssuer
    O->>R: Store short-lived authorization request
    O-->>W: Redirect with request_id
    W->>O: Read and approve using Wegent JWT
    O->>R: Store one-time authorization code
    O-->>W: Return exact redirect URL
    W-->>C: code + original state
    C->>O: POST /external/oauth/token(code, verifier)
    O->>R: Atomically consume code and verify PKCE
    O->>D: Store refresh-token hash
    O-->>C: RFC 9068 access token + refresh token
```

## Refresh sequence

```mermaid
sequenceDiagram
    participant C as External Client
    participant O as OAuth API
    participant D as Database

    C->>O: grant_type=refresh_token
    O->>D: Lock and load token by hash
    O->>D: Validate user, client, issuer, expiry, and revocation
    O->>D: Mark old token used and create replacement in the same family
    O-->>C: New access token + new refresh token
    C->>O: Replay old refresh token
    O->>D: Revoke the entire token family
    O-->>C: invalid_grant
```

## Code ownership

| Responsibility                                                 | Owner                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| OAuth protocol endpoints and errors                            | `backend/app/api/endpoints/oauth_provider.py`                               |
| Clients, codes, JWTs, and refresh rotation                     | `backend/app/services/auth/oauth_provider.py`                               |
| OAuth request, response, and Kind schemas                      | `backend/app/schemas/oauth_provider.py`                                     |
| Refresh-token persistence                                      | `backend/app/models/oauth_refresh_token.py`                                 |
| Developer self-service Client API                              | `backend/app/api/endpoints/oauth_clients.py`                                |
| Administrator Client governance API                            | `backend/app/api/endpoints/admin/oauth_clients.py`                          |
| Automatic provider-level SigningKey / TokenIssuer provisioning | `backend/app/services/auth/outbound_token_service.py`                       |
| Client management and consent UI                               | `frontend/src/features/settings/`, `frontend/src/app/auth/oauth/authorize/` |

## Essential invariants

- External access tokens may access OAuth userinfo only; existing Wegent JWT, API-key, and task-token authentication must reject them.
- Userinfo returns only `id`, `user_name`, and `email`; it never returns roles, auth sources, preferences, Git data, or resource permissions.
- Audience is fixed to `wegent-userinfo`, scope is fixed to `userinfo.read`, and clients cannot expand either.
- Authorization server metadata is published at the RFC 8414 location derived from the issuer, and exposes an OAuth-specific JWKS.
- External OAuth Provider APIs consistently use the `/external/oauth` prefix and do not share a namespace with Wegent login authentication or internal TokenIssuer APIs.
- SigningKey and TokenIssuer are OAuth Provider-level configuration, not OAuth Client configuration. The backend must reuse the same eligible signing resources and atomically create them when first needed; the TokenIssuer access-token maximum is fixed at 3600 seconds and must not depend on Client input.
- An OAuth Client belongs to the developer who created it through `Kind.user_id`. Ordinary users may list, update, rotate, and delete only their own clients, and client names need to be unique only within one owner.
- Administrators globally list, disable, and delete clients; they do not register applications or hold client secrets on behalf of developers.
- Provider protocol resolution searches every active OAuth Client by public `client_id`; it must not be restricted to clients owned by the system user.
- OAuth Client create and update APIs must not accept TokenIssuer or token TTL configuration; each Client manages only its own client id, secret, redirect URIs, and enabled state.
- JWT access tokens follow RFC 9068: they use `typ=at+jwt` and include and validate `iss`, `sub`, `aud`, `exp`, `iat`, `jti`, `client_id`, and `scope`.
- Redirect URIs match registered values exactly; authorization codes require well-formed PKCE S256, expire quickly, and are consumed once.
- Token and revocation endpoints allow exactly one client authentication method and reject requests combining HTTP Basic with body credentials.
- A client's access-token TTL cannot exceed its TokenIssuer limit; a referenced TokenIssuer cannot be deleted or changed to another audience.
- Authorization errors may redirect with the original `state` only after both the client and redirect URI are trusted; otherwise the provider returns a local error to prevent open redirects.
- Refresh tokens are stored only as hashes and rotate on every use; replay revokes the entire family.
- The RFC 7009 revocation endpoint accepts `token_type_hint` and returns success for unknown tokens without revealing token state.
- Disabling or deleting a client, rotating its secret, changing its type, or changing its TokenIssuer revokes its existing refresh tokens.
- Disabled users, clients, TokenIssuers, or SigningKeys cannot issue or refresh tokens.
- The consent page cannot be framed, does not leak Referer data, and is not cached.
- Logs never contain access tokens, refresh tokens, authorization codes, client secrets, or Authorization headers.
