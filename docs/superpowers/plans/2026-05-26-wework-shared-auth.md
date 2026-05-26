# Wework Shared Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Wework reuse Wegent's existing browser authentication state and support password/OIDC login in both web and Tauri app contexts.

**Architecture:** Authentication is moved into a dedicated Wework auth feature that mirrors the original frontend storage keys, token expiration, cookie behavior, redirect handling, and OIDC callback semantics. Workbench bootstrapping consumes the authenticated user from the auth provider instead of fetching `/users/me` itself.

**Tech Stack:** React 19, Vite, TypeScript, Vitest, Testing Library, Tauri 2, existing Wegent REST API.

---

## File Structure

- Create `wework/src/features/auth/redirect.ts`: safe redirect key, redirect sanitizer, and navigation helpers.
- Create `wework/src/features/auth/AuthProvider.tsx`: authenticated user state, login/logout/refresh, token expiry polling.
- Create `wework/src/features/auth/useAuth.ts`: hook and context type export.
- Create `wework/src/pages/LoginPage.tsx`: Wework login UI with password and OIDC entry.
- Create `wework/src/pages/OidcCallbackPage.tsx`: OIDC callback token ingestion and backend callback forwarding.
- Modify `wework/src/api/auth.ts`: full token lifecycle, login API, logout API, OIDC token ingestion.
- Modify `wework/src/api/http.ts`: centralized 401 cleanup and login redirect.
- Modify `wework/src/config/runtime.ts`: add `loginMode` and `oidcLoginText`.
- Modify `wework/src/App.tsx`: light route selection and protected workbench rendering.
- Modify `wework/src/features/workbench/WorkbenchProvider.tsx`: receive user from auth, remove current-user fetch from workbench bootstrap.
- Modify sidebar settings wiring so logout calls auth provider logout.
- Add tests beside the changed modules.

## Task 1: Token Lifecycle And Auth API

**Files:**
- Modify: `wework/src/api/auth.ts`
- Test: `wework/src/api/auth.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createAuthApi,
  getToken,
  getTokenExpire,
  isAuthenticated,
  removeToken,
  setToken,
} from './auth'

function createJwt(expSeconds: number) {
  const payload = btoa(JSON.stringify({ exp: expSeconds }))
  return `header.${payload}.signature`
}

describe('auth token lifecycle', () => {
  beforeEach(() => {
    localStorage.clear()
    document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('stores token, expiration, and cookie using Wegent keys', () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600
    const token = createJwt(expSeconds)

    setToken(token)

    expect(getToken()).toBe(token)
    expect(getTokenExpire()).toBe(expSeconds * 1000)
    expect(document.cookie).toContain(`auth_token=${encodeURIComponent(token)}`)
    expect(isAuthenticated()).toBe(true)
  })

  test('treats expired tokens as unauthenticated', () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) - 60))

    expect(isAuthenticated()).toBe(false)
  })

  test('removes token and cookie', () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) + 3600))

    removeToken()

    expect(getToken()).toBeNull()
    expect(getTokenExpire()).toBeNull()
    expect(document.cookie).not.toContain('auth_token=')
  })
})

describe('createAuthApi', () => {
  test('logs in by storing access token and fetching current user', async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
      post: vi.fn().mockResolvedValue({
        access_token: createJwt(Math.floor(Date.now() / 1000) + 3600),
        token_type: 'bearer',
      }),
      put: vi.fn(),
      delete: vi.fn(),
    }

    const user = await createAuthApi(client).login({ user_name: 'alice', password: 'secret' })

    expect(client.post).toHaveBeenCalledWith('/auth/login', {
      user_name: 'alice',
      password: 'secret',
    })
    expect(client.get).toHaveBeenCalledWith('/users/me')
    expect(user.user_name).toBe('alice')
    expect(isAuthenticated()).toBe(true)
  })
})
```

- [ ] **Step 2: Run failing tests**

Run: `cd wework && npm test -- src/api/auth.test.ts`

Expected: fails because `setToken`, `getTokenExpire`, `isAuthenticated`, and `login` do not exist yet.

- [ ] **Step 3: Implement auth API**

Add token encode/decode, cookie write/remove, `LoginRequest`, `LoginResponse`, and `createAuthApi().login/logout/loginWithOidcToken`.

- [ ] **Step 4: Run passing tests**

Run: `cd wework && npm test -- src/api/auth.test.ts`

Expected: all auth tests pass.

- [ ] **Step 5: Commit**

```bash
git add wework/src/api/auth.ts wework/src/api/auth.test.ts
git commit -m "feat(wework): add shared auth token lifecycle"
```

## Task 2: Redirect Helpers And HTTP 401 Handling

**Files:**
- Create: `wework/src/features/auth/redirect.ts`
- Test: `wework/src/features/auth/redirect.test.ts`
- Modify: `wework/src/api/http.ts`
- Test: `wework/src/api/http.test.ts`

- [ ] **Step 1: Write failing redirect tests**

```ts
import { describe, expect, test } from 'vitest'
import { sanitizeRedirectPath } from './redirect'

describe('sanitizeRedirectPath', () => {
  test('allows safe local paths with query strings', () => {
    expect(sanitizeRedirectPath('/?task=1')).toBe('/?task=1')
  })

  test('rejects external and login-loop redirects', () => {
    expect(sanitizeRedirectPath('https://evil.test')).toBeNull()
    expect(sanitizeRedirectPath('//evil.test')).toBeNull()
    expect(sanitizeRedirectPath('/login', ['/login', '/login/oidc'])).toBeNull()
    expect(sanitizeRedirectPath('/login/oidc', ['/login', '/login/oidc'])).toBeNull()
  })
})
```

- [ ] **Step 2: Write failing HTTP 401 test**

Add to `wework/src/api/http.test.ts`:

```ts
test('clears token and redirects to login on 401', async () => {
  localStorage.setItem('auth_token', 'token-1')
  window.history.pushState({}, '', '/current?x=1')
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ detail: 'Unauthorized' }),
  })

  const client = createHttpClient({ baseUrl: '/api' })

  await expect(client.get('/users/me')).rejects.toMatchObject({ status: 401 })
  expect(localStorage.getItem('auth_token')).toBeNull()
  expect(sessionStorage.getItem('postLoginRedirectPath')).toBe('/current?x=1')
  expect(window.location.pathname).toBe('/login')
})
```

- [ ] **Step 3: Run failing tests**

Run: `cd wework && npm test -- src/features/auth/redirect.test.ts src/api/http.test.ts`

Expected: redirect helper module missing and HTTP 401 behavior absent.

- [ ] **Step 4: Implement redirect helper and 401 handling**

Create `POST_LOGIN_REDIRECT_KEY`, `sanitizeRedirectPath`, `getCurrentRedirectTarget`, and `redirectToLogin`. Update `createHttpClient` to call `removeToken()` and `redirectToLogin()` on 401.

- [ ] **Step 5: Run passing tests**

Run: `cd wework && npm test -- src/features/auth/redirect.test.ts src/api/http.test.ts`

Expected: redirect and HTTP tests pass.

- [ ] **Step 6: Commit**

```bash
git add wework/src/features/auth/redirect.ts wework/src/features/auth/redirect.test.ts wework/src/api/http.ts wework/src/api/http.test.ts
git commit -m "feat(wework): handle shared auth redirects"
```

## Task 3: Auth Provider And Login Pages

**Files:**
- Create: `wework/src/features/auth/AuthProvider.tsx`
- Create: `wework/src/features/auth/useAuth.ts`
- Test: `wework/src/features/auth/AuthProvider.test.tsx`
- Create: `wework/src/pages/LoginPage.tsx`
- Test: `wework/src/pages/LoginPage.test.tsx`
- Create: `wework/src/pages/OidcCallbackPage.tsx`
- Test: `wework/src/pages/OidcCallbackPage.test.tsx`
- Modify: `wework/src/config/runtime.ts`
- Modify: `wework/src/i18n/locales/zh-CN/common.json`
- Modify: `wework/src/i18n/locales/en/common.json`

- [ ] **Step 1: Write failing AuthProvider tests**

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { setToken } from '@/api/auth'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './useAuth'

function Probe() {
  const { user, isLoading } = useAuth()
  return <div data-testid="auth-probe">{isLoading ? 'loading' : user?.user_name ?? 'none'}</div>
}

function createJwt(expSeconds: number) {
  return `header.${btoa(JSON.stringify({ exp: expSeconds }))}.signature`
}

describe('AuthProvider', () => {
  test('loads current user when token is valid', async () => {
    setToken(createJwt(Math.floor(Date.now() / 1000) + 3600))
    const authApi = {
      getCurrentUser: vi.fn().mockResolvedValue({ id: 1, user_name: 'alice', email: 'a@b.c' }),
      login: vi.fn(),
      logout: vi.fn(),
      loginWithOidcToken: vi.fn(),
    }

    render(
      <AuthProvider authApi={authApi}>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('auth-probe')).toHaveTextContent('alice'))
  })
})
```

- [ ] **Step 2: Write failing login and OIDC tests**

Test that LoginPage renders username/password fields, calls auth login, and redirects; test that OIDC callback with `access_token` stores token and redirects to the safe target.

- [ ] **Step 3: Run failing tests**

Run: `cd wework && npm test -- src/features/auth/AuthProvider.test.tsx src/pages/LoginPage.test.tsx src/pages/OidcCallbackPage.test.tsx`

Expected: modules missing.

- [ ] **Step 4: Implement provider, login page, OIDC page, runtime config keys, and i18n**

Use the existing frontend behavior:

- default credentials `admin` / `Wegent2025!`
- `loginMode` values `password`, `oidc`, `all`
- `/api/auth/oidc/login`
- `/api/auth/oidc/callback`
- `postLoginRedirectPath`

- [ ] **Step 5: Run passing tests**

Run: `cd wework && npm test -- src/features/auth/AuthProvider.test.tsx src/pages/LoginPage.test.tsx src/pages/OidcCallbackPage.test.tsx`

Expected: provider and page tests pass.

- [ ] **Step 6: Commit**

```bash
git add wework/src/features/auth wework/src/pages/LoginPage.tsx wework/src/pages/OidcCallbackPage.tsx wework/src/config/runtime.ts wework/src/i18n/locales/en/common.json wework/src/i18n/locales/zh-CN/common.json
git commit -m "feat(wework): add login and oidc auth pages"
```

## Task 4: Protected App And Workbench Integration

**Files:**
- Modify: `wework/src/App.tsx`
- Test: `wework/src/App.test.tsx`
- Modify: `wework/src/features/workbench/WorkbenchProvider.tsx`
- Test: `wework/src/features/workbench/WorkbenchProvider.test.tsx`
- Modify: `wework/src/components/layout/DesktopSidebar.tsx`
- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.tsx`

- [ ] **Step 1: Write failing app routing test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import App from './App'

describe('App auth routing', () => {
  test('renders login page on /login', () => {
    window.history.pushState({}, '', '/login')
    render(<App />)
    expect(screen.getByTestId('login-form')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Update WorkbenchProvider test expectation**

Change the existing bootstrap test so `services.authApi.getCurrentUser` is no longer required; render `WorkbenchProvider` with a `user` prop or consume user from `AuthProvider`.

- [ ] **Step 3: Run failing tests**

Run: `cd wework && npm test -- src/App.test.tsx src/features/workbench/WorkbenchProvider.test.tsx`

Expected: App route handling missing and WorkbenchProvider still owns current-user loading.

- [ ] **Step 4: Implement protected routing and workbench auth integration**

Wrap app in `AuthProvider`; render `LoginPage`, `OidcCallbackPage`, or authenticated `WorkbenchProvider`. Pass authenticated user into workbench bootstrap. Wire settings logout to `useAuth().logout`.

- [ ] **Step 5: Run passing tests**

Run: `cd wework && npm test -- src/App.test.tsx src/features/workbench/WorkbenchProvider.test.tsx`

Expected: app routing and workbench bootstrap tests pass.

- [ ] **Step 6: Commit**

```bash
git add wework/src/App.tsx wework/src/App.test.tsx wework/src/features/workbench/WorkbenchProvider.tsx wework/src/features/workbench/WorkbenchProvider.test.tsx wework/src/components/layout/DesktopSidebar.tsx wework/src/components/layout/DesktopWorkbenchLayout.tsx
git commit -m "feat(wework): protect workbench with shared auth"
```

## Task 5: Final Verification

**Files:**
- Verify all changed Wework files.

- [ ] **Step 1: Run full tests**

Run: `cd wework && npm test`

Expected: all tests pass.

- [ ] **Step 2: Run lint**

Run: `cd wework && npm run lint`

Expected: no lint errors.

- [ ] **Step 3: Run build**

Run: `cd wework && npm run build`

Expected: TypeScript and Vite build complete successfully.

- [ ] **Step 4: Inspect git status**

Run: `git status --short`

Expected: only intentional changes are staged/committed; `wework/.vite/` remains ignored or untracked and is not committed.

## Self-Review

- Spec coverage: token sharing, cookie storage, password login, OIDC callback, Tauri-compatible token handling, 401 redirect, and Workbench auth decoupling are covered by Tasks 1-4.
- Placeholder scan: no TBD/TODO/fill-in steps remain.
- Type consistency: `User`, `LoginRequest`, `LoginResponse`, `AuthProvider`, `useAuth`, and `WorkbenchProvider` boundaries are used consistently across tasks.
