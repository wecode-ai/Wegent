import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const isTauriRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}))

describe('appPreferences', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    isTauriRuntimeMock.mockReset()
  })

  test('uses default preferences outside Tauri', async () => {
    isTauriRuntimeMock.mockReturnValue(false)

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      closeToTrayEnabled: true,
      showMainWindowOnLaunch: true,
      closeToTrayHintSeen: false,
      taskCompletionNotificationsEnabled: true,
      trayUnreadEnabled: true,
      trayRunningEnabled: true,
      trayUsageEnabled: true,
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('merges missing fields from stored preferences', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({ showMainWindowOnLaunch: false })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      closeToTrayEnabled: true,
      showMainWindowOnLaunch: false,
      closeToTrayHintSeen: false,
      taskCompletionNotificationsEnabled: true,
      trayUnreadEnabled: true,
      trayRunningEnabled: true,
      trayUsageEnabled: true,
    })
  })

  test('updates preferences through the Tauri command', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      closeToTrayEnabled: false,
      showMainWindowOnLaunch: true,
      closeToTrayHintSeen: false,
      taskCompletionNotificationsEnabled: true,
      trayUnreadEnabled: true,
      trayRunningEnabled: false,
      trayUsageEnabled: true,
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ closeToTrayEnabled: false })).resolves.toEqual({
      closeToTrayEnabled: false,
      showMainWindowOnLaunch: true,
      closeToTrayHintSeen: false,
      taskCompletionNotificationsEnabled: true,
      trayUnreadEnabled: true,
      trayRunningEnabled: false,
      trayUsageEnabled: true,
    })
    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: { closeToTrayEnabled: false },
    })
  })
})
