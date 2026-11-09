import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createHttpClient } from './http'
import { createQuotaApi } from './quota'
import {
  emptyWegentUsageDisplay,
  extractQuotaSourceLabel,
  getWegentUsageDisplay,
} from './wegentUsage'

vi.mock('./http', () => ({
  createHttpClient: vi.fn(),
}))

vi.mock('./quota', async importOriginal => ({
  ...(await importOriginal<typeof import('./quota')>()),
  createQuotaApi: vi.fn(),
}))

describe('wegentUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'language', {
      configurable: true,
      value: 'zh-CN',
    })
  })

  test('extracts up to five English letters from the quota source', () => {
    expect(extractQuotaSourceLabel('AIGC额度')).toBe('AIGC')
    expect(extractQuotaSourceLabel('ABC-XYZ 模型额度')).toBe('ABCXY')
    expect(extractQuotaSourceLabel('模型额度')).toBe('Quota')
  })

  test('returns no usage when Wegent is disconnected', async () => {
    await expect(
      getWegentUsageDisplay({
        isConnected: false,
        token: null,
      })
    ).resolves.toEqual(emptyWegentUsageDisplay())
    expect(createHttpClient).not.toHaveBeenCalled()
  })

  test('requests quota with the connected Wegent backend and token', async () => {
    const fetchQuota = vi.fn().mockResolvedValue(null)
    vi.mocked(createHttpClient).mockReturnValue({} as never)
    vi.mocked(createQuotaApi).mockReturnValue({ fetchQuota })

    await getWegentUsageDisplay({
      isConnected: true,
      apiBaseUrl: 'https://wegent.example.com/api',
      token: 'token',
    })

    expect(createHttpClient).toHaveBeenCalledWith({
      baseUrl: 'https://wegent.example.com/api',
      getToken: expect.any(Function),
      redirectOnUnauthorized: false,
    })
    const getToken = vi.mocked(createHttpClient).mock.calls[0]?.[0].getToken
    expect(getToken?.()).toBe('token')
    expect(fetchQuota).toHaveBeenCalledTimes(1)
  })
})
