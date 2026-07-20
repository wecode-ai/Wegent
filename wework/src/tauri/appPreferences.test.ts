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
  systemDragEnabled: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  experimentalFeaturesEnabled: false,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  quickPhrases: [
    {
      id: 'default-summary-progress',
      title: '总结当前进展',
      content: '总结目前完成的工作和下一步建议',
      mode: 'normal',
    },
    {
      id: 'default-create-plan',
      title: '制定实施计划',
      content: '分析需求并制定详细的实施计划',
      mode: 'plan',
    },
    {
      id: 'default-pursue-goal',
      title: '持续完成这个目标',
      content: '持续推进这个目标，直到真正完成',
      mode: 'goal',
    },
  ],
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

  test('normalizes stored browser preferences', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      browserExternalLinkTarget: 'wework',
      browserLocalLinkTarget: 'unsupported',
      browserDownloadDirectory: '  /tmp/downloads  ',
      browserAskBeforeDownload: true,
    })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      browserExternalLinkTarget: 'wework',
      browserDownloadDirectory: '/tmp/downloads',
      browserAskBeforeDownload: true,
    })
  })

  test('preserves attachment-only stash phrases', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      quickPhrases: [
        {
          id: 'stash-file',
          title: 'image.png',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/image.png'],
        },
      ],
    })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      quickPhrases: [
        {
          id: 'stash-file',
          title: 'image.png',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/image.png'],
        },
      ],
    })
  })

  test('updates preferences through the Tauri command', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      closeToTrayEnabled: false,
      terminalContextInjectionEnabled: false,
      trayRunningEnabled: false,
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ closeToTrayEnabled: false })).resolves.toEqual({
      ...mergedDefaultPreferences,
      closeToTrayEnabled: false,
      terminalContextInjectionEnabled: false,
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

  test('serializes a cleared browser download directory for the native command', async () => {
    isTauriRuntimeMock.mockReturnValue(true)
    invokeMock.mockResolvedValue(mergedDefaultPreferences)

    const { updateAppPreferences } = await import('./appPreferences')

    await updateAppPreferences({ browserDownloadDirectory: null })

    expect(invokeMock).toHaveBeenCalledWith('update_app_preferences', {
      patch: { browserDownloadDirectory: '' },
    })
  })
})
