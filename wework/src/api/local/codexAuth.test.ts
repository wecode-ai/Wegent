import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  cancelLocalCodexLogin,
  listLocalCodexAccounts,
  startLocalCodexLogin,
  switchLocalCodexAccount,
} from './codexAuth'
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

  test('lists saved accounts and switches the active auth file', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        activeAccountId: 'account-1',
        accounts: [
          {
            id: 'account-1',
            accountType: 'chatgpt',
            email: 'one@example.com',
            planType: 'pro',
            createdAt: 1,
            lastUsedAt: 2,
          },
        ],
      })
      .mockResolvedValueOnce({
        activeAccountId: 'account-2',
        accounts: [
          {
            id: 'account-2',
            accountType: 'chatgpt',
            email: 'two@example.com',
            planType: null,
            createdAt: 3,
            lastUsedAt: 4,
          },
        ],
      })
      .mockResolvedValueOnce({ status: 'canceled' })

    await expect(listLocalCodexAccounts(request)).resolves.toEqual({
      activeAccountId: 'account-1',
      accounts: [
        {
          id: 'account-1',
          accountType: 'chatgpt',
          email: 'one@example.com',
          planType: 'pro',
          createdAt: 1,
          lastUsedAt: 2,
        },
      ],
    })
    await expect(switchLocalCodexAccount(' account-2 ', request)).resolves.toMatchObject({
      activeAccountId: 'account-2',
    })
    await cancelLocalCodexLogin(' login-1 ', request)

    expect(request).toHaveBeenNthCalledWith(1, 'runtime.codex.accounts.list')
    expect(request).toHaveBeenNthCalledWith(2, 'runtime.codex.accounts.switch', {
      accountId: 'account-2',
    })
    expect(request).toHaveBeenLastCalledWith('runtime.codex.auth.login.cancel', {
      loginId: 'login-1',
    })
  })
})
