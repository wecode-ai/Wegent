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

import { migrateLegacyTaskSystemNotification } from './notificationPreferences'

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
})
