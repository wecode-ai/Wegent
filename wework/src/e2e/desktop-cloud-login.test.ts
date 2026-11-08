// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { signInDesktopCloud } from '../../e2e/desktop/modules/desktop-cloud-login.mjs'
import { commandOutputAsync } from '../../e2e/desktop/modules/shared.mjs'
import { pluginApi } from '../../e2e/desktop/modules/plugin-regression-fixture.mjs'

vi.mock('../../e2e/desktop/modules/shared.mjs', async original => ({
  ...(await original<object>()),
  commandOutputAsync: vi.fn(),
}))
vi.mock('../../e2e/desktop/modules/plugin-regression-fixture.mjs', async original => ({
  ...(await original<object>()),
  pluginApi: vi.fn(),
}))

test.each([0, 1])(
  'uses real UI authorization before approving its Backend session (connected=%s)',
  async connected => {
    vi.clearAllMocks()
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
    const cloud = {
      backendUrl: 'http://127.0.0.1:8000',
      authToken: 'fixture-token',
      redisPort: 6379,
    }
    await expect(signInDesktopCloud({ command }, cloud)).resolves.toEqual(user)
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
