import { afterEach, describe, expect, test, vi } from 'vitest'
import { formatCodexUsageDisplay, type CodexRateLimitsResponse } from './codexUsage'

describe('formatCodexUsageDisplay', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('includes local reset times in the tray tooltip', () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'zh-CN',
      configurable: true,
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 2, 10, 0, 0))
    const fiveHourReset = new Date(2026, 0, 2, 11, 30, 0)
    const sevenDayReset = new Date(2026, 0, 5, 9, 15, 0)
    const response: CodexRateLimitsResponse = {
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: {
          usedPercent: 13,
          windowDurationMins: 5 * 60,
          resetsAt: Math.floor(fiveHourReset.getTime() / 1000),
        },
        secondary: {
          usedPercent: 58,
          windowDurationMins: 7 * 24 * 60,
          resetsAt: Math.floor(sevenDayReset.getTime() / 1000),
        },
      },
      rateLimitsByLimitId: null,
    }

    const display = formatCodexUsageDisplay(response)

    expect(display.tooltip).toBe(
      'Codex 额度\n5小时额度 87%（11:30 重置）\n7天额度 42%（1月5日 09:15 重置）'
    )
  })

  test('formats the real app-server rate limit shape', () => {
    Object.defineProperty(window.navigator, 'language', {
      value: 'zh-CN',
      configurable: true,
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 8, 0, 0, 0))

    const display = formatCodexUsageDisplay({
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: {
          resetsAt: 1783452353,
          usedPercent: 21,
          windowDurationMins: 300,
        },
        secondary: {
          resetsAt: 1783999838,
          usedPercent: 9,
          windowDurationMins: 10080,
        },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: null,
          primary: {
            resetsAt: 1783452353,
            usedPercent: 21,
            windowDurationMins: 300,
          },
          secondary: {
            resetsAt: 1783999838,
            usedPercent: 9,
            windowDurationMins: 10080,
          },
        },
      },
    })

    expect(display.tooltip).toContain('5小时额度 79%（')
    expect(display.tooltip).toContain('7天额度 91%（')
    expect(display.tooltip).toContain('重置')
  })
})
