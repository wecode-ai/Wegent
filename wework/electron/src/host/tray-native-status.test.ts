import { describe, expect, test, vi } from 'vitest'
import type { PreferencesStore } from './preferences-store.js'
import { TrayNativeStatusController } from './tray-native-status.js'

describe('tray native status', () => {
  test('builds quota and running status without renderer state', async () => {
    const apply = vi.fn()
    const requestExecutor = vi.fn(async (method: string) => {
      if (method === 'runtime.tasks.running_count') {
        return { runningCount: 1 }
      }
      if (method === 'runtime.codex.rate_limits.read') {
        return {
          rateLimits: {
            primary: { usedPercent: 20, windowDurationMins: 300 },
            secondary: { usedPercent: 40, windowDurationMins: 10_080 },
          },
        }
      }
      if (method === 'executor.codex_home.status') {
        return { shouldPromptMigration: false }
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
      codexSubscriptionActiveAtStartup: true,
    })

    await controller.refresh()

    expect(requestExecutor.mock.calls.map(call => call[0])).toEqual([
      'runtime.tasks.running_count',
      'executor.codex_home.status',
      'executor.backend.quota',
      'runtime.codex.rate_limits.read',
    ])
    expect(apply).toHaveBeenCalledWith({
      usageTitle: 'Codex  60%\nAIGC 845.21',
      usageTooltip:
        '1 个任务运行中\nCodex 额度\n5小时额度 80%\n7天额度 60%\nAIGC额度\n剩余 845.21 元',
      runningCount: 1,
      showRunningStatus: true,
    })
  })

  test('does not initialize Codex while home migration is pending', async () => {
    const apply = vi.fn()
    const requestExecutor = vi.fn(async (method: string) => {
      if (method === 'runtime.tasks.running_count') return { runningCount: 0 }
      if (method === 'executor.codex_home.status') return { shouldPromptMigration: true }
      if (method === 'runtime.codex.rate_limits.read') {
        throw new Error('rate limits must not initialize Codex')
      }
      throw new Error('cloud quota unavailable')
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
      codexSubscriptionActiveAtStartup: true,
    })

    await controller.refresh()

    expect(requestExecutor).not.toHaveBeenCalledWith('runtime.codex.rate_limits.read')
    expect(requestExecutor).not.toHaveBeenCalledWith('device.execute_command', expect.anything())
    expect(requestExecutor).not.toHaveBeenCalledWith('runtime.tasks.list')
    expect(apply).toHaveBeenCalledWith({
      usageTitle: null,
      usageTooltip: null,
      runningCount: 0,
      showRunningStatus: true,
    })
  })

  test('skips Codex quota when the local Codex subscription is off', async () => {
    const apply = vi.fn()
    const requestExecutor = vi.fn(async (method: string) => {
      if (method === 'runtime.tasks.running_count') return { runningCount: 0 }
      if (method === 'runtime.codex.rate_limits.read') {
        throw new Error('rate limits must not be read while the subscription is off')
      }
      if (method === 'executor.codex_home.status') {
        throw new Error('codex home must not be read while the subscription is off')
      }
      throw new Error('cloud quota unavailable')
    })
    const controller = new TrayNativeStatusController({
      preferences: {
        read: vi.fn(async () => ({
          language: 'zh-CN',
          trayRunningEnabled: true,
          trayUsageEnabled: true,
          trayWegentUsageEnabled: false,
          localCodexSubscriptionEnabled: false,
        })),
      } as unknown as PreferencesStore,
      requestExecutor,
      apply,
      codexSubscriptionActiveAtStartup: true,
    })

    await controller.refresh()

    expect(requestExecutor.mock.calls.map(call => call[0])).toEqual(['runtime.tasks.running_count'])
    expect(apply).toHaveBeenCalledWith({
      usageTitle: null,
      usageTooltip: null,
      runningCount: 0,
      showRunningStatus: true,
    })
  })

  test('skips Codex quota when the subscription was off at startup but is now on', async () => {
    const apply = vi.fn()
    const requestExecutor = vi.fn(async (method: string) => {
      if (method === 'runtime.tasks.running_count') return { runningCount: 0 }
      if (method === 'runtime.codex.rate_limits.read') {
        throw new Error('rate limits must wait for the restarted executor')
      }
      if (method === 'executor.codex_home.status') {
        throw new Error('codex home must wait for the restarted executor')
      }
      throw new Error('cloud quota unavailable')
    })
    const controller = new TrayNativeStatusController({
      preferences: {
        read: vi.fn(async () => ({
          language: 'zh-CN',
          trayRunningEnabled: true,
          trayUsageEnabled: true,
          trayWegentUsageEnabled: false,
          localCodexSubscriptionEnabled: true,
        })),
      } as unknown as PreferencesStore,
      requestExecutor,
      apply,
      codexSubscriptionActiveAtStartup: false,
    })

    await controller.refresh()

    expect(requestExecutor.mock.calls.map(call => call[0])).toEqual(['runtime.tasks.running_count'])
    expect(apply).toHaveBeenCalledWith({
      usageTitle: null,
      usageTooltip: null,
      runningCount: 0,
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
      codexSubscriptionActiveAtStartup: true,
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
