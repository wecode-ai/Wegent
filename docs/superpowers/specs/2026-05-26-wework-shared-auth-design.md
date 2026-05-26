---
sidebar_position: 26
---

# Wework Shared Authentication Design

## Goal

Wework should behave as another Wegent client, not as a separate product with a separate login state.

When Wework runs on the same browser origin as the existing frontend, it must reuse the existing Wegent authentication token and cookie. If the user logs in from Wework, the existing frontend should also recognize the login without asking again. When Wework is packaged as a Tauri desktop app, it must still support password login and OIDC login through the same backend authentication APIs.

## Current State

The existing frontend already owns the mature authentication behavior:

- `frontend/src/apis/user.ts` stores `auth_token`, `auth_token_expire`, and the `auth_token` cookie.
- `frontend/src/features/common/UserContext.tsx` checks token expiration, fetches `/users/me`, redirects to `/login`, and exposes login/logout state.
- `frontend/src/app/login/page.tsx` and `frontend/src/features/login/components/LoginForm.tsx` support password login, login mode configuration, redirect restoration, and OIDC entry.
- `frontend/src/app/login/oidc/page.tsx` handles OIDC callback token ingestion and redirect restoration.

Wework currently has a thin authentication layer:

- `wework/src/api/auth.ts` only reads and removes token values and fetches `/users/me`.
- `wework/src/api/http.ts` attaches `Authorization` headers but does not centralize 401 redirect behavior.
- `wework/src/features/workbench/WorkbenchProvider.tsx` bootstraps user, team, projects, and recent tasks together, so authentication failure currently looks like a generic bootstrap failure.
- `wework/src/App.tsx` always renders the workbench provider and page.

## Recommended Approach

Implement a shared authentication core inside Wework that mirrors the existing frontend behavior and uses the same storage keys and backend endpoints.

This gives three important properties:

- Same-origin Web sharing: Wework and the existing frontend share `localStorage` and cookies.
- Login from either client: password login in Wework writes the same token and cookie that the existing frontend already understands.
- Desktop readiness: Tauri can use the same backend APIs while storing its own local token inside the app WebView.

## Architecture

### Authentication API

Expand `wework/src/api/auth.ts` into the single owner of authentication token behavior:

- `setToken(token)` writes `auth_token`, JWT expiration into `auth_token_expire`, and an `auth_token` cookie with `SameSite=Lax`.
- `getToken()` and `getTokenExpire()` read the shared values.
- `removeToken()` clears local storage and removes the cookie.
- `isAuthenticated()` returns true only when a token exists and is not expired.
- `createAuthApi(client)` exposes:
  - `login({ user_name, password })`
  - `logout()`
  - `getCurrentUser()`
  - `loginWithOidcToken(accessToken)`

The token key names must remain identical to the existing frontend so same-origin sharing works.

### HTTP 401 Handling

Update `wework/src/api/http.ts` so every API call has consistent authentication behavior:

- Attach `Authorization: Bearer <token>` when a token exists.
- On HTTP 401, remove the token, save the current safe redirect target, and navigate to `/login`.
- Preserve normal `ApiError` parsing for non-auth failures.

The redirect sanitizer should be shared with auth routing so unsafe absolute URLs, protocol-relative URLs, and login-loop targets are rejected.

### Auth Provider

Add `wework/src/features/auth/AuthProvider.tsx` as the auth state boundary:

- On mount, check `isAuthenticated()`.
- If missing or expired, expose `user: null` and redirect to `/login` for protected routes.
- If valid, fetch `/users/me` and expose the current user.
- Expose `login`, `logout`, and `refresh`.
- Periodically re-check token expiration, matching the existing frontend behavior.

Workbench data loading should depend on this provider instead of fetching current user inside the workbench bootstrap.

### Routing

Keep routing light and local to Wework:

- `/login` renders the Wework login page.
- `/login/oidc` renders the OIDC callback page.
- Other paths render the authenticated workbench.

This can be implemented without adding a full router dependency by reading `window.location.pathname` and using small navigation helpers.

### Login Page

Add a Wework login page modeled on the existing frontend page:

- Password login form with username and password fields.
- Default local dev credentials matching the existing frontend: `admin` / `Wegent2025!`.
- Login button loading state.
- Runtime-config-aware login mode: `password`, `oidc`, or `all`.
- OIDC button text from runtime config.
- Redirect restoration through `postLoginRedirectPath`.

The visual treatment should stay consistent with Wework: calm white surface, centered login card, and Wework brand text. The behavior should match the existing frontend rather than inventing new authentication semantics.

### OIDC

Wework should support the same OIDC flow:

- When users click OIDC login, navigate to `/api/auth/oidc/login`, including a sanitized redirect target when present.
- When `/login/oidc` receives `access_token` and `login_success=true`, write the token through `loginWithOidcToken()` and redirect to the stored target.
- When `/login/oidc` receives `code` and `state`, forward to `/api/auth/oidc/callback`.
- When callback parameters are invalid or error is present, clear redirect state and return to `/login`.

For Tauri desktop packaging, the first implementation should rely on opening the backend OIDC login in the system browser or WebView-supported navigation and ingesting the returned token through the same callback page. Native deep-link registration can be added later if the deployment requires a custom app callback scheme.

### Runtime Configuration

Extend `wework/src/config/runtime.ts` with:

- `loginMode`
- `oidcLoginText`

These values should default to the existing frontend behavior:

- `loginMode: 'all'`
- `oidcLoginText: ''`

The existing `apiBaseUrl` and `socketBaseUrl` behavior should remain unchanged.

### Workbench Integration

Update `WorkbenchProvider` so it receives the authenticated user from `AuthProvider`:

- Remove `authApi.getCurrentUser()` from the workbench bootstrap.
- Load default team, projects, and recent tasks only after auth is ready and `user` exists.
- Keep existing task, project, team, and chat-stream behavior unchanged.

This keeps authentication and workbench data loading decoupled.

### Logout

The existing sidebar settings logout menu should call the auth provider logout method:

- Clear token and cookie.
- Clear current user.
- Navigate to `/login`.

This makes logout consistent between the web client and desktop client.

## Testing

Add focused tests around behavior rather than visual snapshots:

- Token management stores and clears `auth_token`, `auth_token_expire`, and cookie values.
- HTTP 401 clears token and redirects to `/login`.
- Auth provider bootstraps a current user when a valid token exists.
- Auth provider redirects to login when missing or expired token.
- Login form calls `/auth/login`, stores token, fetches `/users/me`, and redirects.
- OIDC callback stores `access_token` and redirects to the safe target.
- Workbench provider no longer fetches current user as part of workbench bootstrap.

Run Wework verification after implementation:

- `npm test`
- `npm run lint`
- `npm run build`

## Non-Goals

- No backend authentication API changes.
- No new auth storage key names.
- No separate Wework account system.
- No unrelated redesign of the workbench shell.
- No native Tauri deep-link scheme in the first pass unless required by testing the packaged app flow.

## Acceptance Criteria

- Opening same-origin Wework after logging into the existing frontend enters the workbench without re-login.
- Logging into Wework lets the existing frontend reuse the same browser login state.
- Expired or invalid auth redirects to `/login` instead of showing a generic bootstrap failure.
- Password login and OIDC login both use existing backend endpoints.
- Tauri builds retain a functional login path using the same auth API and token handling.
