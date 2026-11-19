// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { installAndReconnectExpiredConnector } from '../../e2e/desktop/scenarios/connector-oauth.scenario.mjs'

const slug = 'desktop-connector-oauth'
const pluginId = 73
const manage = `[data-testid="plugin-connection-manage-connector:${slug}"]`
type RefreshPhase = 'publish' | 'install' | 'detail' | 'manage'
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'connector-oauth-recovery-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function fixture(
  phase: RefreshPhase,
  { refreshAttempts = 1, consentAttempts = 1, consentTokens = 1 } = {}
) {
  const provider = { refreshRequests: 4, authorizeRequests: 7, tokenRequests: 11 }
  const plugin = { pluginId }
  let connected = false
  const refresh = (current: RefreshPhase) => {
    if (current !== phase) return
    provider.refreshRequests += refreshAttempts
    provider.tokenRequests += refreshAttempts
  }
  const cloudEnvironment = {
    publishPluginRelease: vi.fn(async ({ packageRoot }: { packageRoot: string }) => {
      const manifest = JSON.parse(
        await readFile(join(packageRoot, '.codex-plugin', 'plugin.json'), 'utf8')
      )
      expect(manifest.connectors).toEqual([
        { slug, displayName: 'Desktop connector OAuth', authPolicy: 'on_use' },
      ])
      refresh('publish')
      return plugin
    }),
  }
  const api = vi.fn(async (path: string, options?: { method: string }) => {
    if (path === `/api/plugins/marketplace/${pluginId}/install?device_id=app-record-20`) {
      expect(options).toEqual({ method: 'POST' })
      refresh('install')
      return {}
    }
    expect(path).toBe('/api/connector-apps')
    return [{ slug, connection: { status: connected ? 'connected' : 'expired' } }]
  })
  const command = vi.fn(async (action: string, selector: string) => {
    if (action === 'click' && selector === `[data-testid="plugin-marketplace-row-${pluginId}"]`)
      refresh('detail')
    if (action === 'clickWhenEnabled' && selector === manage) {
      refresh('manage')
      provider.authorizeRequests += consentAttempts
      provider.tokenRequests += consentTokens
      connected = true
    }
    return ''
  })
  const run = () =>
    installAndReconnectExpiredConnector(
      { command },
      {
        provider,
        resultDir: directory,
        publishPluginRelease: cloudEnvironment.publishPluginRelease,
        appDevice: { device_id: 'app-record-20' },
        api,
        uiTimeoutMs: 1000,
      }
    )
  return { provider, command, cloudEnvironment, api, plugin, run }
}

test.each(['publish', 'install', 'detail', 'manage'] as const)(
  'counts the single rejected refresh when it occurs during %s',
  async phase => {
    const state = fixture(phase)
    expect(await state.run()).toEqual({ plugin: state.plugin, manage })
    expect(state.provider).toEqual({ refreshRequests: 5, authorizeRequests: 8, tokenRequests: 13 })
    expect(state.cloudEnvironment.publishPluginRelease).toHaveBeenCalledOnce()
    expect(
      state.command.mock.calls.filter(
        ([action, selector]) => action === 'clickWhenEnabled' && selector === manage
      )
    ).toHaveLength(1)
  }
)

test.each([0, 2])('rejects %s refresh attempts without retrying consent', async refreshAttempts => {
  const state = fixture('install', { refreshAttempts })
  await expect(state.run()).rejects.toThrow('must exercise exactly one rejected refresh')
  expect(
    state.command.mock.calls.filter(
      ([action, selector]) => action === 'clickWhenEnabled' && selector === manage
    )
  ).toHaveLength(1)
})

test('still requires exactly one provider consent', async () => {
  await expect(fixture('manage', { consentAttempts: 0 }).run()).rejects.toThrow(
    'exactly one provider consent'
  )
})

test('still requires both token exchanges to reach the provider', async () => {
  await expect(fixture('manage', { consentTokens: 0 }).run()).rejects.toThrow(
    'each reach the token endpoint once'
  )
})
