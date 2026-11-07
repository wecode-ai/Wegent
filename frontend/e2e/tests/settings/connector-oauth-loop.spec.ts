import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import {
  CONNECTOR_OAUTH_ALLOWED_TOOL,
  CONNECTOR_OAUTH_HIDDEN_TOOL,
  CONNECTOR_OAUTH_TOOL_RESULT,
} from '../../utils/mock-connector-oauth-provider'

/**
 * The administrator-published connector flow end to end: real RFC 9728/8414
 * discovery, dynamic client registration, PKCE, the browser redirect, the
 * stored grant, the administrator allowlist, and the refresh/re-authorization
 * states. Only the model service is mocked elsewhere in the stack; nothing in
 * this file stubs the provider, the backend or the MCP resource.
 */

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MOCK_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const SLUG = `e2e-connector-oauth-${Date.now().toString(36)}`

interface ConnectorConnectionView {
  status: string
  external_account_name: string | null
  last_error: string | null
  tool_count: number
}

interface InstalledAppView {
  slug: string
  callable: boolean
  connection: ConnectorConnectionView
  tool_summaries: Array<{ name: string; raw_tool_name: string | null }>
}

async function authorizeViaApi(
  request: APIRequestContext,
  token: string,
  slug: string
): Promise<void> {
  const started = await request.post(`${API_URL}/api/connector-apps/${slug}/oauth/sessions`, {
    headers: authHeaders(token),
  })
  expect(started.ok(), await started.text()).toBeTruthy()
  const session = (await started.json()) as { authorize_url: string }
  const consent = await request.get(session.authorize_url, { maxRedirects: 0 })
  expect(consent.status()).toBe(302)
  const callback = await request.get(consent.headers().location)
  expect(callback.ok(), await callback.text()).toBeTruthy()
  expect(await callback.text()).toContain('Connector is connected')
}

async function connectorRuntimeToken(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.post(`${API_URL}/api/connector-runtime/token`, {
    headers: authHeaders(token),
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return ((await response.json()) as { access_token: string }).access_token
}

async function loginToken(
  request: APIRequestContext,
  user: { username: string; password: string }
): Promise<string> {
  const client = createApiClient(request)
  const response = await client.login(user.username, user.password)
  expect(response.data?.access_token, `login failed for ${user.username}`).toBeTruthy()
  return response.data!.access_token
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function installedApp(
  request: APIRequestContext,
  token: string
): Promise<InstalledAppView | undefined> {
  const response = await request.get(`${API_URL}/api/apps/installed`, {
    headers: authHeaders(token),
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = (await response.json()) as { apps: InstalledAppView[] }
  return body.apps.find(app => app.slug === SLUG)
}

async function providerControl(
  request: APIRequestContext,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await request.post(`${MOCK_URL}/connector-oauth/_control`, { data: payload })
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()) as Record<string, unknown>
}

async function openIntegrations(page: Page): Promise<void> {
  await page.goto('/settings?tab=integrations', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('connector-app-connections')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(`connector-app-connection-${SLUG}`)).toBeVisible({
    timeout: 30_000,
  })
}

/** Click the card's authorize button and finish the provider consent page. */
async function authorizeThroughProvider(page: Page): Promise<void> {
  const popupPromise = page.waitForEvent('popup')
  await page.getByTestId(`authorize-connector-app-${SLUG}`).click()
  const popup = await popupPromise
  await popup.waitForURL(/\/api\/connector-apps\/oauth\/callback/, { timeout: 30_000 })
  await expect(popup.locator('body')).toContainText('Connector is connected', {
    timeout: 30_000,
  })
  await popup.close()
}

test.describe.configure({ mode: 'serial' })

test.describe('Connector app OAuth loop', () => {
  let adminToken = ''
  let appId = 0

  test.beforeAll(async ({ request }) => {
    adminToken = await loginToken(request, ADMIN_USER)
    await providerControl(request, {
      tokenTtlSeconds: 3600,
      rejectRefresh: false,
      revokeAll: true,
    })
    await providerControl(request, { rejectRefresh: false })
    const created = await request.post(`${API_URL}/api/admin/connector-apps`, {
      headers: authHeaders(adminToken),
      data: {
        slug: SLUG,
        name: 'E2E Connector OAuth',
        description: 'Provider-backed connector used by the OAuth loop E2E.',
        transport: 'streamable-http',
        mcp_url: `${MOCK_URL}/connector-oauth/mcp`,
        auth_type: 'oauth2',
        oauth_scope: 'mcp.read',
        tool_allowlist: [CONNECTOR_OAUTH_ALLOWED_TOOL],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    appId = ((await created.json()) as { id: number }).id
  })

  test.afterAll(async ({ request }) => {
    if (appId) {
      await request.delete(`${API_URL}/api/admin/connector-apps/${appId}`, {
        headers: authHeaders(adminToken),
      })
    }
    await providerControl(request, { rejectRefresh: false, revokeAll: true })
  })

  test('authorizes through the provider and exposes only allowlisted tools', async ({
    page,
    request,
  }) => {
    await openIntegrations(page)
    await authorizeThroughProvider(page)

    // The card reflects the stored grant without a reload.
    await expect(page.getByTestId(`authorize-connector-app-${SLUG}`)).toHaveCount(0, {
      timeout: 30_000,
    })
    await expect(page.getByTestId(`disconnect-connector-app-${SLUG}`)).toBeVisible()

    // The stored surface proves the allowlist filtered a real `tools/list`.
    const installed = await installedApp(request, adminToken)
    expect(installed?.connection.status).toBe('connected')
    expect((installed?.tool_summaries ?? []).map(tool => tool.raw_tool_name)).toEqual([
      CONNECTOR_OAUTH_ALLOWED_TOOL,
    ])

    // An actual call reaches the upstream with the stored credential.
    const allowed = await request.post(`${API_URL}/api/admin/connector-apps/${appId}/tools/test`, {
      headers: authHeaders(adminToken),
      data: { name: CONNECTOR_OAUTH_ALLOWED_TOOL, arguments: { value: 'payload' } },
    })
    expect(allowed.ok(), await allowed.text()).toBeTruthy()
    expect(await allowed.text()).toContain(CONNECTOR_OAUTH_TOOL_RESULT)

    const blocked = await request.post(`${API_URL}/api/admin/connector-apps/${appId}/tools/test`, {
      headers: authHeaders(adminToken),
      data: { name: CONNECTOR_OAUTH_HIDDEN_TOOL, arguments: {} },
    })
    expect(blocked.status()).toBe(403)
    expect(await blocked.text()).toContain('disabled')

    const provider = (await (await request.get(`${MOCK_URL}/connector-oauth/_state`)).json()) as {
      toolCalls: Array<{ name: string }>
    }
    expect(provider.toolCalls.map(call => call.name)).toContain(CONNECTOR_OAUTH_ALLOWED_TOOL)
    expect(provider.toolCalls.map(call => call.name)).not.toContain(CONNECTOR_OAUTH_HIDDEN_TOOL)
  })

  test('keeps another user without the caller grant', async ({ request }) => {
    const regularToken = await loginToken(request, REGULAR_USER)

    // `/api/apps/installed` only publishes apps the caller can use, so the
    // second user sees no entry until they authorize the app themselves.
    const installed = await installedApp(request, regularToken)
    expect(installed).toBeUndefined()

    // The admin's own grant survives the second caller's read.
    const admin = await installedApp(request, adminToken)
    expect(admin?.connection.status).toBe('connected')
  })

  test('refreshes an expired grant and asks for authorization after revocation', async ({
    page,
    request,
  }) => {
    /** Re-authorize with a grant that expires almost immediately. */
    const authorizeShortLivedGrant = async () => {
      await request.delete(`${API_URL}/api/connector-apps/${SLUG}/connection`, {
        headers: authHeaders(adminToken),
      })
      await providerControl(request, { tokenTtlSeconds: 1, rejectRefresh: false })
      await openIntegrations(page)
      await authorizeThroughProvider(page)
      // The grant is deliberately short-lived: wait for the expiry the refresh
      // assertion depends on instead of racing the card's connected state.
      await page.waitForTimeout(2_000)
    }

    // An expired grant is renewed from the stored refresh token.
    await authorizeShortLivedGrant()
    await providerControl(request, { tokenTtlSeconds: 3600, rejectRefresh: false })
    const refreshed = await request.post(
      `${API_URL}/api/connector-apps/${SLUG}/connection/refresh`,
      { headers: authHeaders(adminToken) }
    )
    expect(refreshed.ok(), await refreshed.text()).toBeTruthy()
    const refreshedBody = (await refreshed.json()) as ConnectorConnectionView
    expect(refreshedBody.status).toBe('connected')
    expect(refreshedBody.last_error).toBeNull()
    const afterRefresh = (await (
      await request.get(`${MOCK_URL}/connector-oauth/_state`)
    ).json()) as { refreshes: number }
    expect(afterRefresh.refreshes).toBeGreaterThan(0)

    // A revoked grant keeps the connection unusable and reopens authorization.
    await authorizeShortLivedGrant()
    await providerControl(request, { rejectRefresh: true })
    const rejected = await request.post(
      `${API_URL}/api/connector-apps/${SLUG}/connection/refresh`,
      { headers: authHeaders(adminToken) }
    )
    // A revoked grant is a rejected request: the handler keeps the stored
    // connection but reports the rejection instead of pretending to recover.
    expect(rejected.status()).toBe(400)
    expect(await rejected.text()).toContain('rejected')
    const revoked = await installedApp(request, adminToken)
    expect(revoked?.connection.status).toBe('expired')

    await openIntegrations(page)
    await expect(page.getByTestId(`authorize-connector-app-${SLUG}`)).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId(`disconnect-connector-app-${SLUG}`)).toHaveCount(0)
  })

  test('rejects duplicate callbacks while successful polling remains idempotent', async ({
    request,
  }) => {
    await providerControl(request, { tokenTtlSeconds: 3600, rejectRefresh: false })
    const started = await request.post(`${API_URL}/api/connector-apps/${SLUG}/oauth/sessions`, {
      headers: authHeaders(adminToken),
    })
    expect(started.ok(), await started.text()).toBeTruthy()
    const session = (await started.json()) as {
      authorize_url: string
      session_id: string
      poll_token: string
    }
    const consent = await request.get(session.authorize_url, { maxRedirects: 0 })
    expect(consent.status()).toBe(302)
    const callbackUrl = consent.headers().location
    expect(callbackUrl).toBeTruthy()
    const callback = await request.get(callbackUrl)
    expect(callback.ok(), await callback.text()).toBeTruthy()
    expect(await callback.text()).toContain('Connector is connected')

    const replay = await request.get(callbackUrl)
    expect(replay.status()).toBe(409)
    const pollUrl = `${API_URL}/api/connector-apps/oauth/sessions/${session.session_id}/poll`
    const views = await Promise.all(
      [1, 2].map(async () => {
        const response = await request.get(pollUrl, {
          headers: authHeaders(adminToken),
          params: { poll_token: session.poll_token },
        })
        expect(response.ok(), await response.text()).toBeTruthy()
        return response.json()
      })
    )
    for (const view of views) {
      expect(view.status).toBe('success')
      expect(view.connection.status).toBe('connected')
    }
    expect(views[0]).toEqual(views[1])
  })

  test('publishes the default enabled DingTalk apps after backend startup', async ({ request }) => {
    const response = await request.get(`${API_URL}/api/admin/connector-apps`, {
      headers: authHeaders(adminToken),
    })
    expect(response.ok(), await response.text()).toBeTruthy()
    const apps = (await response.json()) as Array<{
      slug: string
      enabled: boolean
      auth_type: string
      tool_loading_mode: string
    }>
    for (const slug of ['dingtalk_docs', 'dingtalk_sheet', 'dingtalk_aitable', 'dingtalk_wiki']) {
      const app = apps.find(item => item.slug === slug)
      expect(app, `missing startup app ${slug}`).toBeDefined()
      expect(app?.enabled).toBe(true)
      expect(app?.auth_type).toBe('oauth2')
      expect(app?.tool_loading_mode).toBe('lazy')
    }
  })

  test('discovers and calls a legacy SSE connector without requiring a user grant', async ({
    request,
  }) => {
    const slug = `${SLUG}-sse`
    let id = 0
    try {
      const created = await request.post(`${API_URL}/api/admin/connector-apps`, {
        headers: authHeaders(adminToken),
        data: {
          slug,
          name: 'Legacy SSE protocol connector',
          transport: 'sse',
          mcp_url: `${MOCK_URL}/connector-oauth/sse`,
          auth_type: 'none',
          tool_allowlist: [CONNECTOR_OAUTH_ALLOWED_TOOL],
        },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      id = ((await created.json()) as { id: number }).id
      const regularToken = await loginToken(request, REGULAR_USER)
      const installed = await request.get(`${API_URL}/api/apps/installed`, {
        headers: authHeaders(regularToken),
      })
      expect(installed.ok(), await installed.text()).toBeTruthy()
      const app = ((await installed.json()) as { apps: InstalledAppView[] }).apps.find(
        item => item.slug === slug
      )
      expect(app?.connection.status).toBe('connected')
      expect(app?.callable).toBe(true)
      expect(app?.tool_summaries.map(tool => tool.raw_tool_name)).toEqual([
        CONNECTOR_OAUTH_ALLOWED_TOOL,
      ])
      const token = await connectorRuntimeToken(request, regularToken)
      const called = await request.post(`${API_URL}/api/connector-runtime/call`, {
        headers: authHeaders(token),
        data: { name: `${slug}__echo`, arguments: { value: slug } },
      })
      expect(called.ok(), await called.text()).toBeTruthy()
      expect(await called.text()).toContain(CONNECTOR_OAUTH_TOOL_RESULT)
      const blocked = await request.post(`${API_URL}/api/connector-runtime/call`, {
        headers: authHeaders(token),
        data: { name: `${slug}__${CONNECTOR_OAUTH_HIDDEN_TOOL}`, arguments: {} },
      })
      expect(blocked.status()).toBe(403)
      const provider = await request.get(`${MOCK_URL}/connector-oauth/_state`)
      expect(provider.ok(), await provider.text()).toBeTruthy()
      const calls = (
        (await provider.json()) as {
          toolCalls: Array<{ name: string; arguments: { value?: string } }>
        }
      ).toolCalls.filter(call => call.arguments.value === slug)
      expect(calls).toEqual([{ name: 'echo', arguments: { value: slug } }])
    } finally {
      if (id) {
        const removed = await request.delete(`${API_URL}/api/admin/connector-apps/${id}`, {
          headers: authHeaders(adminToken),
        })
        expect(removed.status()).toBe(204)
      }
    }
  })

  test('refreshes HTTP definitions without executing a tool, then calls with the stored grant', async ({
    request,
  }) => {
    const slug = `${SLUG}-http`
    let id = 0
    const definition = {
      name: 'lookup',
      description: 'Read one record through real HTTP',
      method: 'GET',
      path: '/records/{id}',
      input_schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, detail: { type: 'string' } },
      },
      argument_locations: { id: 'path', detail: 'query' },
    }
    const httpCalls = async () => {
      const response = await request.get(`${MOCK_URL}/connector-oauth/_state`)
      expect(response.ok(), await response.text()).toBeTruthy()
      return (
        (await response.json()) as {
          httpCalls: Array<{ method: string; path: string; query: Record<string, string> }>
        }
      ).httpCalls
    }
    try {
      const created = await request.post(`${API_URL}/api/admin/connector-apps`, {
        headers: authHeaders(adminToken),
        data: {
          slug,
          name: 'HTTP OAuth operations',
          transport: 'http',
          mcp_url: `${MOCK_URL}/connector-oauth/mcp`,
          auth_type: 'oauth2',
          http_tools: [definition],
          tool_allowlist: ['lookup'],
        },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      id = ((await created.json()) as { id: number }).id
      await authorizeViaApi(request, adminToken, slug)
      const before = await httpCalls()
      const updated = await request.patch(`${API_URL}/api/admin/connector-apps/${id}`, {
        headers: authHeaders(adminToken),
        data: {
          http_tools: [{ ...definition, name: 'lookup_current' }],
          tool_allowlist: ['lookup_current'],
        },
      })
      expect(updated.ok(), await updated.text()).toBeTruthy()
      const refreshed = await request.post(
        `${API_URL}/api/connector-apps/${slug}/connection/refresh`,
        { headers: authHeaders(adminToken) }
      )
      expect(refreshed.ok(), await refreshed.text()).toBeTruthy()
      expect(await refreshed.json()).toMatchObject({
        status: 'connected',
        tool_count: 1,
        last_error: null,
      })
      expect(await httpCalls()).toEqual(before)
      const runtimeToken = await connectorRuntimeToken(request, adminToken)
      const call = async (name: string, args: Record<string, unknown>) =>
        request.post(`${API_URL}/api/connector-runtime/call`, {
          headers: authHeaders(runtimeToken),
          data: { name: `${slug}__${name}`, arguments: args },
        })
      expect((await call('lookup_current', {})).status()).toBe(422)
      expect((await call('lookup', { id: 'a/b' })).status()).toBe(403)
      expect(await httpCalls()).toEqual(before)
      const called = await call('lookup_current', { id: 'a/b', detail: 'full' })
      expect(called.ok(), await called.text()).toBeTruthy()
      expect(await called.text()).toContain(CONNECTOR_OAUTH_TOOL_RESULT)
      expect((await httpCalls()).slice(before.length)).toEqual([
        {
          method: 'GET',
          path: '/connector-oauth/mcp/records/a%2Fb',
          query: { detail: 'full' },
        },
      ])
      await providerControl(request, { rejectHttp: true })
      expect((await call('lookup_current', { id: 'a/b' })).status()).toBe(401)
      await providerControl(request, { rejectRefresh: true })
      const rejected = await request.post(
        `${API_URL}/api/connector-apps/${slug}/connection/refresh`,
        { headers: authHeaders(adminToken) }
      )
      expect(rejected.status()).toBe(400)
      const installed = await request.get(`${API_URL}/api/apps/installed`, {
        headers: authHeaders(adminToken),
      })
      expect(installed.ok(), await installed.text()).toBeTruthy()
      const expired = ((await installed.json()) as { apps: InstalledAppView[] }).apps.find(
        app => app.slug === slug
      )
      // An expired grant is projected from the refresh cache, not live inline
      // discovery. This distinguishes a fresh cache from the old definition.
      expect(expired?.connection.status).toBe('expired')
      expect(expired?.tool_summaries.map(tool => tool.raw_tool_name)).toEqual(['lookup_current'])
      expect(expired?.callable).toBe(false)
      const disconnected = await request.delete(
        `${API_URL}/api/connector-apps/${slug}/connection`,
        { headers: authHeaders(adminToken) }
      )
      expect(disconnected.status()).toBe(204)
      expect((await call('lookup_current', { id: 'a/b' })).status()).toBe(401)
      expect((await httpCalls()).length).toBe(before.length + 1)
    } finally {
      await providerControl(request, { rejectHttp: false, rejectRefresh: false })
      if (id) {
        const removed = await request.delete(`${API_URL}/api/admin/connector-apps/${id}`, {
          headers: authHeaders(adminToken),
        })
        expect(removed.status()).toBe(204)
      }
    }
  })

  test('does not restore disabled cached tools and enforces current visibility with an issued token', async ({
    page,
    request,
  }) => {
    const slug = `${SLUG}-policy`
    let id = 0
    const readInstalled = async () => {
      const response = await request.get(`${API_URL}/api/apps/installed`, {
        headers: authHeaders(adminToken),
      })
      expect(response.ok(), await response.text()).toBeTruthy()
      return ((await response.json()) as { apps: InstalledAppView[] }).apps.find(
        app => app.slug === slug
      )
    }
    try {
      const created = await request.post(`${API_URL}/api/admin/connector-apps`, {
        headers: authHeaders(adminToken),
        data: {
          slug,
          name: 'Policy-controlled connector',
          transport: 'streamable-http',
          mcp_url: `${MOCK_URL}/connector-oauth/mcp`,
          auth_type: 'oauth2',
          tool_allowlist: [CONNECTOR_OAUTH_ALLOWED_TOOL],
        },
      })
      expect(created.ok(), await created.text()).toBeTruthy()
      id = ((await created.json()) as { id: number }).id
      await authorizeViaApi(request, adminToken, slug)
      expect((await readInstalled())?.tool_summaries.map(tool => tool.raw_tool_name)).toEqual([
        CONNECTOR_OAUTH_ALLOWED_TOOL,
      ])
      const runtimeToken = await connectorRuntimeToken(request, adminToken)
      const call = () =>
        request.post(`${API_URL}/api/connector-runtime/call`, {
          headers: authHeaders(runtimeToken),
          data: { name: `${slug}__${CONNECTOR_OAUTH_ALLOWED_TOOL}`, arguments: {} },
        })
      const edit = async (data: Record<string, unknown>) => {
        const response = await request.patch(`${API_URL}/api/admin/connector-apps/${id}`, {
          headers: authHeaders(adminToken),
          data,
        })
        expect(response.ok(), await response.text()).toBeTruthy()
      }
      await providerControl(request, { toolNames: [] })
      const empty = await readInstalled()
      expect(empty?.connection.status).toBe('connected')
      expect(empty?.tool_summaries).toEqual([])
      expect(empty?.callable).toBe(false)
      await providerControl(request, {
        toolNames: [CONNECTOR_OAUTH_ALLOWED_TOOL, CONNECTOR_OAUTH_HIDDEN_TOOL],
      })
      // No upstream tool matches this new allowlist. The cache still contains
      // echo, so an unfiltered fallback incorrectly makes the app callable.
      await edit({ tool_allowlist: ['not_served_by_upstream'] })
      const filtered = await readInstalled()
      expect(filtered?.connection.status).toBe('connected')
      expect(filtered?.tool_summaries).toEqual([])
      expect(filtered?.callable).toBe(false)
      expect((await call()).status()).toBe(403)

      await edit({ tool_allowlist: [CONNECTOR_OAUTH_ALLOWED_TOOL], enabled: false })
      expect(await readInstalled()).toBeUndefined()
      expect((await call()).status()).toBe(404)
      await page.goto('/settings?tab=integrations', { waitUntil: 'domcontentloaded' })
      await expect(page.getByTestId('connector-app-connections')).toBeVisible()
      await expect(page.getByTestId(`connector-app-connection-${SLUG}`)).toBeVisible()
      await expect(page.getByTestId(`connector-app-connection-${slug}`)).toHaveCount(0)

      await edit({ enabled: true, visibility: 'roles', allowed_roles: ['user'] })
      expect(await readInstalled()).toBeUndefined()
      expect((await call()).status()).toBe(404)
      await edit({ visibility: 'all' })
      expect((await readInstalled())?.callable).toBe(true)
      const called = await call()
      expect(called.ok(), await called.text()).toBeTruthy()
      expect(await called.text()).toContain(CONNECTOR_OAUTH_TOOL_RESULT)
    } finally {
      await providerControl(request, {
        toolNames: [CONNECTOR_OAUTH_ALLOWED_TOOL, CONNECTOR_OAUTH_HIDDEN_TOOL],
      })
      if (id) {
        const removed = await request.delete(`${API_URL}/api/admin/connector-apps/${id}`, {
          headers: authHeaders(adminToken),
        })
        expect(removed.status()).toBe(204)
      }
    }
  })

  for (const mutation of ['delete-recreate', 'change-resource'] as const) {
    test(`rejects pending consent after ${mutation}`, async ({ request }) => {
      const slug = `${SLUG}-${mutation}`
      const payload = {
        slug,
        name: 'Pending consent replacement',
        transport: 'streamable-http',
        mcp_url: `${MOCK_URL}/connector-oauth/mcp`,
        auth_type: 'oauth2',
      }
      let replacementId = 0
      const create = async () => {
        const response = await request.post(`${API_URL}/api/admin/connector-apps`, {
          headers: authHeaders(adminToken),
          data: payload,
        })
        expect(response.ok(), await response.text()).toBeTruthy()
        replacementId = ((await response.json()) as { id: number }).id
        return replacementId
      }
      try {
        const originalId = await create()
        const started = await request.post(`${API_URL}/api/connector-apps/${slug}/oauth/sessions`, {
          headers: authHeaders(adminToken),
        })
        expect(started.ok(), await started.text()).toBeTruthy()
        const session = (await started.json()) as {
          authorize_url: string
          session_id: string
          poll_token: string
        }
        const consent = await request.get(session.authorize_url, { maxRedirects: 0 })
        expect(consent.status()).toBe(302)
        if (mutation === 'delete-recreate') {
          const removed = await request.delete(
            `${API_URL}/api/admin/connector-apps/${originalId}`,
            {
              headers: authHeaders(adminToken),
            }
          )
          expect(removed.status()).toBe(204)
          const missing = await request.get(`${API_URL}/api/admin/connector-apps/${originalId}`, {
            headers: authHeaders(adminToken),
          })
          expect(missing.status()).toBe(404)
          expect(await create()).not.toBe(originalId)
        } else {
          const updated = await request.patch(`${API_URL}/api/admin/connector-apps/${originalId}`, {
            headers: authHeaders(adminToken),
            data: { mcp_url: `${payload.mcp_url}?replacement=1` },
          })
          expect(updated.ok(), await updated.text()).toBeTruthy()
          expect((await updated.json()).oauth_client_registered).toBe(false)
        }

        const callback = await request.get(consent.headers().location)
        expect(callback.status()).toBe(mutation === 'delete-recreate' ? 404 : 409)
        const poll = await request.get(
          `${API_URL}/api/connector-apps/oauth/sessions/${session.session_id}/poll`,
          { headers: authHeaders(adminToken), params: { poll_token: session.poll_token } }
        )
        expect(poll.ok(), await poll.text()).toBeTruthy()
        expect((await poll.json()).status).toBe('failed')
        const installed = await request.get(`${API_URL}/api/apps/installed`, {
          headers: authHeaders(adminToken),
        })
        expect(installed.ok(), await installed.text()).toBeTruthy()
        const apps = ((await installed.json()) as { apps: InstalledAppView[] }).apps
        expect(apps.find(app => app.slug === slug)).toBeUndefined()
      } finally {
        if (replacementId) {
          const removed = await request.delete(
            `${API_URL}/api/admin/connector-apps/${replacementId}`,
            { headers: authHeaders(adminToken) }
          )
          expect(removed.status()).toBe(204)
        }
      }
    })
  }
})
