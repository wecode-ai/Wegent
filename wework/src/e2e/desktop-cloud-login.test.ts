// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { signInDesktopCloud } from '../../e2e/desktop/modules/desktop-cloud-login.mjs'
import { commandOutputAsync, redisCliBinary } from '../../e2e/desktop/modules/shared.mjs'
import { pluginApi } from '../../e2e/desktop/modules/plugin-regression-fixture.mjs'

vi.mock('../../e2e/desktop/modules/shared.mjs', async original => ({
  ...(await original<object>()),
  commandOutputAsync: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/plugin-regression-fixture.mjs', async original => ({
  ...(await original<object>()),
  pluginApi: vi.fn(),
}))

afterEach(() => vi.unstubAllEnvs())

test('resolves the CLI shipped alongside the configured Windows Redis server', () => {
  expect(redisCliBinary('C:\\e2e tools\\redis\\redis-server.exe', 'win32')).toBe(
    'C:\\e2e tools\\redis\\redis-cli.exe'
  )
  expect(redisCliBinary('/opt/redis/bin/redis-server', 'linux')).toBe('/opt/redis/bin/redis-cli')
  expect(redisCliBinary('', 'win32')).toBe('redis-cli')
})

test.each([0, 1])(
  'uses real UI authorization before approving its Backend session (connected=%s)',
  async connected => {
    vi.clearAllMocks()
    const redisRoot = join(process.cwd(), 'isolated-redis-tools')
    vi.stubEnv('WEWORK_E2E_REDIS_SERVER_BIN', join(redisRoot, 'redis-server'))
    const id = '12345678-1234-1234-1234-123456789abc'
    vi.mocked(commandOutputAsync)
      .mockResolvedValueOnce('old-session\n')
      .mockResolvedValue(`old-session\nwework_auth_session:${id}\n`)
    const user = { id: 17, user_name: 'fixture-owner' }
    vi.mocked(pluginApi)
      .mockResolvedValueOnce(user)
      .mockImplementation(async (_cloud, path: string) => {
        expect(path).toBe(`/auth/wework/sessions/${id}/approve`)
        expect(command).toHaveBeenCalledWith(
          'clickWhenEnabled',
          '[data-testid="cloud-authorization-submit-button"]'
        )
        return { status: 'approved' }
      })
    const command = vi.fn(async (action: string, selector?: string) => {
      if (action === 'getElementCount') return connected
      if (action === 'getText' && selector === '[data-testid="cloud-connection-status-card"]')
        return user.user_name
      return undefined
    })
    let pollingReady!: () => void
    const polling = new Promise<void>(resolve => {
      pollingReady = resolve
    })
    const cloud = {
      backendUrl: 'http://127.0.0.1:8000',
      authToken: 'fixture-token',
      redisPort: 6379,
      waitForAuthorizationPolling: vi.fn(() => polling),
    }
    const login = signInDesktopCloud({ command }, cloud)
    await vi.waitFor(() => expect(cloud.waitForAuthorizationPolling).toHaveBeenCalledWith(id))
    expect(pluginApi).toHaveBeenCalledTimes(1)
    pollingReady()
    await expect(login).resolves.toEqual(user)
    const focus = command.mock.calls.findIndex(([action]) => action === 'focusMainWindow')
    const connectedCard = command.mock.calls.findIndex(
      ([action, selector]) =>
        action === 'waitFor' && selector === '[data-testid="cloud-connection-status-card"]'
    )
    expect(focus).toBeGreaterThan(-1)
    expect(vi.mocked(pluginApi).mock.invocationCallOrder.at(-1)).toBeLessThan(
      command.mock.invocationCallOrder[focus]
    )
    expect(focus).toBeLessThan(connectedCard)
    expect(command).toHaveBeenCalledWith(
      'waitFor',
      '[data-testid="cloud-connection-status-card"]',
      {
        text: user.user_name,
        visible: true,
        timeoutMs: 10_000,
      }
    )
    expect(commandOutputAsync).toHaveBeenCalledWith(
      join(redisRoot, process.platform === 'win32' ? 'redis-cli.exe' : 'redis-cli'),
      ['-p', '6379', '--raw', '--scan', '--pattern', '*wework_auth_session:*']
    )
    expect(command).toHaveBeenCalledWith('fill', '[data-testid="cloud-backend-url-input"]', {
      value: cloud.backendUrl,
    })
    expect(command).toHaveBeenCalledWith('waitFor', '[data-testid="desktop-sidebar-account"]', {
      text: user.user_name,
      visible: true,
    })
    expect(command.mock.calls.some(([action]) => /seed|ensure|resume/i.test(action))).toBe(false)
    expect(
      command.mock.calls.filter(
        ([action, selector]) =>
          action === 'clickWhenEnabled' &&
          selector === '[data-testid="settings-cloud-disconnect-button"]'
      )
    ).toHaveLength(connected)
  }
)
