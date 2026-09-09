import { beforeEach, describe, expect, test, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invokeMock,
}))

const mergedDefaultPreferences = {
  workbenchMode: 'developer',
  appearanceMode: 'system',
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  fixedWorkspaceTabs: [
    { id: 'fixed-task', kind: 'task' },
    { id: 'fixed-board', kind: 'board' },
    { id: 'fixed-agent', kind: 'agent' },
  ],
  startupWorkspaceTabId: 'fixed-task',
  systemDragEnabled: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  contextCompactionThreshold: 85,
  experimentalFeaturesEnabled: false,
  telemetryConsentAsked: false,
  telemetryEnabled: false,
  supervisorPrinciples: '',
  supervisorModelSelection: null,
  supervisorIntervalSeconds: 30,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  trayWegentUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  computerUseEnabled: false,
  popoutWindowShortcut: 'Alt+Shift+Space',
  popoutWindowProjectlessDefaultEnabled: false,
  friendlyTaskTitlesEnabled: false,
  friendlyTaskTitleModel: null,
  changeRequestStatusEnabled: true,
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
  localHarnesses: [
    {
      id: 'opencode',
      enabled: true,
      executablePath: null,
      args: [],
      env: {},
      permissionMode: 'default',
    },
    {
      id: 'claude_code',
      enabled: true,
      executablePath: null,
      args: [],
      env: {},
      permissionMode: 'default',
    },
    {
      id: 'kimi_code',
      enabled: true,
      executablePath: null,
      args: [],
      env: {},
      permissionMode: 'default',
    },
  ],
  cloudConnection: null,
}

describe('appPreferences', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
  })

  test('merges missing fields from stored preferences', async () => {
    invokeMock.mockResolvedValue({ showMainWindowOnLaunch: false })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      showMainWindowOnLaunch: false,
    })
  })

  test('preserves the desktop cloud connection snapshot', async () => {
    const cloudConnection = {
      backendUrl: 'https://cloud.example.com',
      apiBaseUrl: 'https://cloud.example.com/api',
      socketBaseUrl: 'wss://cloud.example.com',
      socketPath: '/socket.io',
      token: 'cloud-token',
      tokenExpiresAt: null,
      user: { id: 7, user_name: 'alice' },
      connectedAt: '2026-08-26T00:00:00.000Z',
    }
    invokeMock.mockResolvedValue({ cloudConnection })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      cloudConnection,
    })
  })

  test('falls back to the default language for invalid stored language values', async () => {
    invokeMock.mockResolvedValue({ language: 'fr' })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
  })

  test('normalizes the workbench mode and preserves existing behavior by default', async () => {
    invokeMock.mockResolvedValue({ workbenchMode: 'focus' })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      workbenchMode: 'focus',
    })

    invokeMock.mockResolvedValue({ workbenchMode: 'unknown' })
    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
  })

  test('migrates the legacy default workspace tab preference', async () => {
    invokeMock.mockResolvedValue({ defaultWorkspaceTab: 'board' })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      startupWorkspaceTabId: 'fixed-board',
    })

    invokeMock.mockResolvedValue({ defaultWorkspaceTab: 'unsupported' })

    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
  })

  test('normalizes fixed workspace tabs and the startup tab', async () => {
    invokeMock.mockResolvedValue({
      fixedWorkspaceTabs: [
        { id: 'smart-1', kind: 'smart_app', installationId: 'app-1', title: 'Research' },
        { id: 'invalid-smart', kind: 'smart_app' },
      ],
      startupWorkspaceTabId: 'missing',
    })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      fixedWorkspaceTabs: [
        { id: 'smart-1', kind: 'smart_app', installationId: 'app-1', title: 'Research' },
      ],
      startupWorkspaceTabId: 'smart-1',
    })
  })

  test('normalizes stored browser preferences', async () => {
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

  test('normalizes the last selected supervisor model', async () => {
    invokeMock.mockResolvedValue({
      supervisorModelSelection: {
        modelName: '  review-model  ',
        modelType: 'public',
        options: {
          weworkCloudModelNamespace: 'default',
          invalid: 1,
        },
      },
    })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      supervisorModelSelection: {
        modelName: 'review-model',
        modelType: 'public',
        options: {
          weworkCloudModelNamespace: 'default',
        },
      },
    })
  })

  test('normalizes the last selected supervisor interval', async () => {
    invokeMock.mockResolvedValue({ supervisorIntervalSeconds: 60 })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      supervisorIntervalSeconds: 60,
    })

    invokeMock.mockResolvedValue({ supervisorIntervalSeconds: 15 })
    await expect(getAppPreferences()).resolves.toEqual(mergedDefaultPreferences)
  })

  test('clamps the context compaction threshold to 1..100', async () => {
    invokeMock.mockResolvedValue({ contextCompactionThreshold: 250 })

    const { getAppPreferences } = await import('./appPreferences')

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      contextCompactionThreshold: 100,
    })

    invokeMock.mockResolvedValue({ contextCompactionThreshold: 0 })

    await expect(getAppPreferences()).resolves.toEqual({
      ...mergedDefaultPreferences,
      contextCompactionThreshold: 1,
    })
  })

  test('preserves attachment-only stash phrases', async () => {
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

  test('removes stash phrases after seven days and preserves regular phrases', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'))
    const now = Date.now()
    invokeMock.mockResolvedValue({
      quickPhrases: [
        {
          id: `stash-${now - 7 * 24 * 60 * 60 * 1000}`,
          title: '过期暂存',
          content: '过期',
          mode: 'normal',
        },
        {
          id: 'stash-recent',
          title: '近期暂存',
          content: '近期',
          mode: 'normal',
          createdAt: now - 7 * 24 * 60 * 60 * 1000 + 1,
        },
        { id: 'regular', title: '普通短语', content: '保留', mode: 'normal' },
      ],
    })

    const { getAppPreferences } = await import('./appPreferences')
    const preferences = await getAppPreferences()

    expect(preferences.quickPhrases.map(phrase => phrase.id)).toEqual(['stash-recent', 'regular'])
    vi.useRealTimers()
  })

  test('updates preferences through the Electron host', async () => {
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
    expect(invokeMock).toHaveBeenCalledWith('preferences.update', {
      patch: { closeToTrayEnabled: false },
    })
  })

  test('updates language preferences through the Electron host', async () => {
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      language: 'en',
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ language: 'en' })).resolves.toEqual({
      ...mergedDefaultPreferences,
      language: 'en',
    })
    expect(invokeMock).toHaveBeenCalledWith('preferences.update', {
      patch: { language: 'en' },
    })
  })

  test('updates the startup appearance mode through the Electron host', async () => {
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      appearanceMode: 'dark',
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await expect(updateAppPreferences({ appearanceMode: 'dark' })).resolves.toEqual({
      ...mergedDefaultPreferences,
      appearanceMode: 'dark',
    })
    expect(invokeMock).toHaveBeenCalledWith('preferences.update', {
      patch: { appearanceMode: 'dark' },
    })
  })

  test('sends a cleared browser download directory to the Electron host', async () => {
    invokeMock.mockResolvedValue(mergedDefaultPreferences)

    const { updateAppPreferences } = await import('./appPreferences')

    await updateAppPreferences({ browserDownloadDirectory: null })

    expect(invokeMock).toHaveBeenCalledWith('preferences.update', {
      patch: { browserDownloadDirectory: null },
    })
  })

  test('sends a cleared Popout Window shortcut to the Electron host', async () => {
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      popoutWindowShortcut: null,
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await updateAppPreferences({ popoutWindowShortcut: null })

    expect(invokeMock).toHaveBeenCalledWith('preferences.update', {
      patch: { popoutWindowShortcut: null },
    })
  })

  test('serializes all nullable preference clears in the same patch', async () => {
    invokeMock.mockResolvedValue({
      ...mergedDefaultPreferences,
      browserDownloadDirectory: null,
      popoutWindowShortcut: null,
    })

    const { updateAppPreferences } = await import('./appPreferences')

    await updateAppPreferences({
      browserDownloadDirectory: null,
      popoutWindowShortcut: null,
    })

    expect(invokeMock).toHaveBeenCalledWith('preferences.update', {
      patch: {
        browserDownloadDirectory: null,
        popoutWindowShortcut: null,
      },
    })
  })
})
