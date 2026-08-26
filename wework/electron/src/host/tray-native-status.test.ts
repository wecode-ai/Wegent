import { describe, expect, test, vi } from 'vitest'
import type { PreferencesStore } from './preferences-store.js'
import { countRunningTasks, TrayNativeStatusController } from './tray-native-status.js'

describe('tray native status', () => {
  test('counts executor tasks from explicit and normalized running states', () => {
    expect(
      countRunningTasks({
        workspaces: [
          {
            tasks: [
              { running: true },
              { status: 'running' },
              { turnStatus: 'in_progress' },
              { status: 'active' },
              { status: 'done' },
            ],
          },
        ],
      })
    ).toBe(3)
  })

  test('builds quota and running status without renderer state', async () => {
    const apply = vi.fn()
    const requestExecutor = vi.fn(async (method: string) => {
      if (method === 'runtime.tasks.list') {
        return { workspaces: [{ tasks: [{ running: true }, { status: 'done' }] }] }
      }
      if (method === 'runtime.codex.rate_limits.read') {
        return {
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 300 },
            secondary: { usedPercent: 40, windowDurationMins: 10_080 },
          },
        }
      }
      return {
        data: { remaining: 845.21 },
        quota_source: 'AIGC额度',
      }
    })
    const controller = new TrayNativeStatusController({
      preferences: {
        read: vi.fn(async () => ({
          language: 'zh-CN',
          trayRunningEnabled: true,
          trayUsageEnabled: true,
          trayWegentUsageEnabled: true,
        })),
      } as unknown as PreferencesStore,
      requestExecutor,
      apply,
    })

    await controller.refresh()

    expect(requestExecutor.mock.calls.map(call => call[0])).toEqual([
      'runtime.tasks.list',
      'runtime.codex.rate_limits.read',
      'executor.backend.quota',
    ])
    expect(apply).toHaveBeenCalledWith({
      usageTitle: 'Codex  60%\nAIGC 845.21',
      usageTooltip:
        '1 个任务运行中\nCodex 额度\n5小时额度 80%\n7天额度 60%\nAIGC额度\n剩余 845.21 元',
      runningCount: 1,
      showRunningStatus: true,
    })
  })

  test('respects native tray preferences and tolerates unavailable quota sources', async () => {
    const apply = vi.fn()
    const requestExecutor = vi.fn(async () => {
      throw new Error('unavailable')
    })
    const controller = new TrayNativeStatusController({
      preferences: {
        read: vi.fn(async () => ({
          language: 'en',
          trayRunningEnabled: false,
          trayUsageEnabled: false,
          trayWegentUsageEnabled: true,
        })),
      } as unknown as PreferencesStore,
      requestExecutor,
      apply,
    })

    await controller.refresh()

    expect(requestExecutor).toHaveBeenCalledOnce()
    expect(requestExecutor).toHaveBeenCalledWith('executor.backend.quota')
    expect(apply).toHaveBeenCalledWith({
      usageTitle: null,
      usageTooltip: null,
      runningCount: 0,
      showRunningStatus: false,
    })
  })
})
