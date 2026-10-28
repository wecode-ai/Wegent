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
  connection: ConnectorConnectionView
  tool_summaries: Array<{ name: string; raw_tool_name: string | null }>
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

    const installed = await installedApp(request, regularToken)
    expect(installed?.connection.status).toBe('disconnected')
    expect(installed?.tool_summaries ?? []).toEqual([])

    // The admin's own grant survives the second caller's read.
    const admin = await installedApp(request, adminToken)
    expect(admin?.connection.status).toBe('connected')
  })

  test('refreshes an expired grant and asks for authorization after revocation', async ({
    page,
    request,
  }) => {
    // Expire the stored grant quickly and prove the refresh endpoint renews it.
    await request.delete(`${API_URL}/api/connector-apps/${SLUG}/connection`, {
      headers: authHeaders(adminToken),
    })
    await providerControl(request, { tokenTtlSeconds: 1, rejectRefresh: false })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await authorizeThroughProvider(page)
    await expect(page.getByTestId(`disconnect-connector-app-${SLUG}`)).toBeVisible({
      timeout: 30_000,
    })
    await page.waitForTimeout(2_000)

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
    await providerControl(request, { tokenTtlSeconds: 1, rejectRefresh: true })
    await page.waitForTimeout(2_000)
    const rejected = await request.post(
      `${API_URL}/api/connector-apps/${SLUG}/connection/refresh`,
      { headers: authHeaders(adminToken) }
    )
    expect(rejected.ok(), await rejected.text()).toBeTruthy()
    expect(((await rejected.json()) as ConnectorConnectionView).status).toBe('expired')

    await openIntegrations(page)
    await expect(page.getByTestId(`authorize-connector-app-${SLUG}`)).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId(`disconnect-connector-app-${SLUG}`)).toHaveCount(0)
  })
})
