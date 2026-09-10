import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cancelLocalCodexLogin, hasLocalCodexAccount, startLocalCodexLogin } from './codexAuth'
import { ensureLocalExecutorStarted } from '@/desktop/localExecutor'

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn().mockResolvedValue({
    running: true,
    ready: true,
  }),
  requestLocalExecutor: vi.fn(),
}))

const ensureLocalExecutorStartedMock = vi.mocked(ensureLocalExecutorStarted)

describe('local Codex auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('starts the managed Codex browser login flow', async () => {
    const request = vi.fn().mockResolvedValue({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/auth',
    })

    await expect(startLocalCodexLogin(request)).resolves.toEqual({
      type: 'chatgpt',
      loginId: 'login-1',
      authUrl: 'https://chatgpt.com/auth',
    })

    expect(ensureLocalExecutorStartedMock).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('runtime.codex.auth.login.start')
  })

  test('rejects an incomplete login response', async () => {
    const request = vi.fn().mockResolvedValue({
      type: 'chatgpt',
      loginId: 'login-1',
    })

    await expect(startLocalCodexLogin(request)).rejects.toThrow(
      'Codex returned an invalid login response'
    )
  })

  test('reads account state and cancels the matching login', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ account: null })
      .mockResolvedValueOnce({ account: { type: 'chatgpt' } })
      .mockResolvedValueOnce({ status: 'canceled' })

    await expect(hasLocalCodexAccount(request)).resolves.toBe(false)
    await expect(hasLocalCodexAccount(request)).resolves.toBe(true)
    await cancelLocalCodexLogin(' login-1 ', request)

    expect(request).toHaveBeenNthCalledWith(1, 'runtime.codex.auth.read')
    expect(request).toHaveBeenNthCalledWith(2, 'runtime.codex.auth.read')
    expect(request).toHaveBeenLastCalledWith('runtime.codex.auth.login.cancel', {
      loginId: 'login-1',
    })
  })
})
