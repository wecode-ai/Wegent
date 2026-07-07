import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const isTauriRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}))

const mergedDefaultPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
}

describe('appPreferences', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    isTauriRuntimeMock.mockReset()
  })

  test('uses default preferences outside Tauri', async () => {
    isTauriRuntimeMock.mockReturnValue(false)

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('merges missing fields from stored preferences', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({ showMainWindowOnLaunch: false })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      showMainWindowOnLaunch: false,
    })
  })

  test('falls back to the default language for invalid stored language values', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({ language: 'fr' })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
  })

  test('updates preferences through the Tauri command', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      closeToTrayEnabled: false,
      trayRunningEnabled: false,
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ closeToTrayEnabled: false })).resolves.toEqual({
      ...mergedDefaultPreferences,
      closeToTrayEnabled: false,
      trayRunningEnabled: false,
    })
    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: { closeToTrayEnabled: false },
    })
  })

  test('updates language preferences through the Tauri command', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      language: 'en',
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ language: 'en' })).resolves.toEqual({
      ...mergedDefaultPreferences,
      language: 'en',
    })
    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: { language: 'en' },
    })
  })
})
