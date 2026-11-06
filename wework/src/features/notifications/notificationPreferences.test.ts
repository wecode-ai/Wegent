import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  electron: true,
  invokeDesktopHost: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: mocks.invokeDesktopHost,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => mocks.electron,
}))

import {
  cacheNotificationPreferences,
  migrateLegacyTaskSystemNotification,
  readActiveNotificationPreferences,
  readCachedNotificationPreferences,
} from './notificationPreferences'

describe('notification preference migration', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.electron = true
    mocks.invokeDesktopHost.mockReset()
  })

  test('migrates the enabled legacy task system setting once per account', async () => {
    mocks.invokeDesktopHost.mockResolvedValue({
      taskCompletionNotificationsEnabled: true,
    })
    const enable = vi.fn().mockResolvedValue(undefined)

    await migrateLegacyTaskSystemNotification('account-1', enable)
    await migrateLegacyTaskSystemNotification('account-1', enable)

    expect(mocks.invokeDesktopHost).toHaveBeenCalledOnce()
    expect(mocks.invokeDesktopHost).toHaveBeenCalledWith('preferences.get')
    expect(enable).toHaveBeenCalledOnce()
  })

  test('does not read desktop preferences outside Electron', async () => {
    mocks.electron = false

    await migrateLegacyTaskSystemNotification('account-2', vi.fn())

    expect(mocks.invokeDesktopHost).not.toHaveBeenCalled()
  })

  test('enables stand-in alerts for existing records without changing task opt-outs', () => {
    localStorage.setItem(
      'wework.notification-preferences:local:1',
      JSON.stringify({
        tasks: { in_app: true, system: false, im: null },
      })
    )
    const preferences = readCachedNotificationPreferences('local:1')
    expect(preferences.stand_in).toEqual({ in_app: true, system: true, im: null })
    expect(preferences.tasks.system).toBe(false)
  })

  test('preserves explicit stand-in opt-outs across active and account cache reloads', () => {
    const preferences = readCachedNotificationPreferences('local:1')
    cacheNotificationPreferences('local:1', {
      ...preferences,
      stand_in: { in_app: false, system: false, im: null },
    })
    expect(readCachedNotificationPreferences('local:1').stand_in).toEqual({
      in_app: false,
      system: false,
      im: null,
    })
    expect(readActiveNotificationPreferences().stand_in.system).toBe(false)
    expect(readCachedNotificationPreferences('other:2').stand_in.system).toBe(true)
  })
})
