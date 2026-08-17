import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createHttpClient } from './http'
import { createQuotaApi } from './quota'
import {
  emptyWegentUsageDisplay,
  extractQuotaSourceLabel,
  formatWegentUsageDisplay,
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

  test('formats the top-level cloud quota and preserves negative remaining quota', () => {
    const display = formatWegentUsageDisplay({
      quota: 1042,
      usage: 1126.7,
      remaining: -84.7,
      usage_rate: 1.0813,
      user: 'alice',
      quota_source: 'AIGC',
      user_quota_detail: {
        demand_quota: 0,
        monthly_quota: 0,
        monthly_usage: 0,
        permanent_quota: 0,
        permanent_usage: 0,
        task_quota: 0,
      },
    })

    expect(display).toEqual({
      status: 'available',
      sourceText: 'AIGC额度',
      sourceLabel: 'AIGC',
      quota: 1042,
      usage: 1126.7,
      remaining: -84.7,
      usageRate: expect.closeTo(108.1285988),
      value: '1,126.7 / 1,042 元',
      detail: '已用 108.13% · 剩余 -84.7 元',
      trayTitle: 'AIGC -84.7',
      tooltip: 'AIGC额度\n1,126.7 / 1,042 元 (108.13%)\n剩余 -84.7 元',
    })
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
