// @vitest-environment node

import { afterEach, expect, test, vi } from 'vitest'
import { verifyConnectorAccountSwitch } from '../../e2e/desktop/modules/connector-account-switch.mjs'
import {
  pathExists,
  requestPluginExecutor,
} from '../../e2e/desktop/modules/plugin-regression-fixture.mjs'
import { switchPersonalPluginAccount } from '../../e2e/desktop/modules/plugin-personal-uninstall-flow.mjs'

vi.mock('../../e2e/desktop/modules/plugin-regression-fixture.mjs', async original => ({
  ...(await original<object>()),
  pathExists: vi.fn(),
  requestPluginExecutor: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/plugin-personal-uninstall-flow.mjs', async original => ({
  ...(await original<object>()),
  switchPersonalPluginAccount: vi.fn(),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function fixtureApi(slug: string) {
  return vi.fn(async (path: string, options?: { method?: string }) => {
    if (options?.method === 'DELETE') return null
    if (path === '/api/users/me') return { id: 1, role: 'admin' }
    if (path === '/api/admin/users') return { id: 2, user_name: 'recipient-fixture' }
    if (path === '/api/auth/login') return { access_token: 'recipient-fixture' }
    if (path.endsWith('/oauth/sessions')) return { authorize_url: 'http://provider.test/consent' }
    if (path === '/api/apps/installed')
      return { apps: [{ slug, tool_summaries: [{ raw_tool_name: 'echo' }] }] }
    if (path === '/api/admin/connector-apps') return { id: 3 }
    throw new Error(`Unexpected fixture request: ${path}`)
  })
}

function fixture(polluteOldSync = false) {
  const slug = 'desktop-connector-oauth'
  const restrictedSlug = `${slug}-admin-only`
  const backend = { backendUrl: 'http://backend.test', authToken: 'owner-fixture' }
  let page = '/'
  let account = backend.authToken
  let oldSyncCompleted = false
  const apps = () => [
    { slug, skillPath: `/runtime/skills/wegent-connector-${slug}/SKILL.md` },
    ...(account === backend.authToken || (oldSyncCompleted && polluteOldSync)
      ? [{ slug: restrictedSlug }]
      : []),
  ]
  vi.mocked(pathExists).mockResolvedValue(false)
  vi.mocked(requestPluginExecutor).mockImplementation(async () => ({
    status: 200,
    payload: { ok: true, result: { configured: true, apps: apps() } },
  }))
  vi.mocked(switchPersonalPluginAccount).mockImplementation(async (_control, cloud) => {
    expect(page, 'Account identity must be observed on the workbench, not settings').toBe('/')
    account = cloud.authToken
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/consent')
        ? new Response(null, {
            status: 302,
            headers: { location: 'http://provider.test/callback' },
          })
        : new Response('Connector is connected')
    )
  )
  const api = fixtureApi(slug)
  const command = vi.fn(async (action: string, selector: string, options?: { value?: string }) => {
    if (action === 'navigate') page = options?.value ?? '/'
    if (action === 'waitFor' && selector.includes('connector-'))
      expect(page, 'Connector assertions must observe their settings surface').toBe(
        '/settings/connections'
      )
    if (action === 'awaitLocalExecutorRequestHold') return JSON.stringify({ heldCount: 1 })
    if (action === 'releaseLocalExecutorRequestHold') {
      oldSyncCompleted = true
      return 'true'
    }
    if (action === 'getLocalExecutorRequestHoldSnapshot')
      return JSON.stringify({ completedCount: 1 })
    if (action === 'getElementCount') return 0
    return ''
  })
  return { input: { control: { command }, backend, api, slug, mcpUrl: 'http://provider.test/mcp' } }
}

test('connector account switching establishes both identity and settings page prerequisites', async () => {
  const { input } = fixture()

  await expect(verifyConnectorAccountSwitch(input)).resolves.toEqual({
    oldSyncCompleted: true,
    restrictedCatalogAbsent: true,
    restrictedSkillAbsent: true,
  })

  expect(switchPersonalPluginAccount).toHaveBeenCalledTimes(2)
  expect(pathExists).toHaveBeenCalledWith(
    '/runtime/skills/wegent-connector-desktop-connector-oauth-admin-only/SKILL.md'
  )
  expect(input.control.command).toHaveBeenCalledWith(
    'waitFor',
    '[data-testid="connector-connection-desktop-connector-oauth"]'
  )
  expect(input.api).toHaveBeenCalledWith('/api/admin/connector-apps/3', { method: 'DELETE' })
  expect(input.api).toHaveBeenCalledWith('/api/admin/users/2', { method: 'DELETE' })
})

test('page setup does not weaken old-account catalog isolation and restores the owner after failure', async () => {
  const { input } = fixture(true)

  await expect(verifyConnectorAccountSwitch(input)).rejects.toThrow(
    'An old sync polluted the new account catalog'
  )

  expect(switchPersonalPluginAccount).toHaveBeenCalledTimes(2)
  expect(switchPersonalPluginAccount).toHaveBeenLastCalledWith(input.control, input.backend)
  expect(input.api).toHaveBeenCalledWith('/api/admin/users/2', { method: 'DELETE' })
})
