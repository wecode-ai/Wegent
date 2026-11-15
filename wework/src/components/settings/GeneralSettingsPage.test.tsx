import { setSessionTelemetryConsent } from '@/telemetry/sessionConsent'
import type { AppPreferences } from '@/desktop/appPreferences'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GeneralSettingsPage } from './GeneralSettingsPage'
import { RuntimeConcurrencySettings } from './RuntimeConcurrencySettings'

const defaultPreferences: AppPreferences = {
  workbenchMode: 'developer',
  appearanceMode: 'system',
  appearanceThemeSnapshot: null,
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
  telemetryConsentAsked: true,
  telemetryEnabled: true,
  telemetryConsentRevision: 0,
  performanceRecordingEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  trayWegentUsageEnabled: true,
  localCodexSubscriptionEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserFullControl: false,
  browserAskBeforeDownload: false,
  appshotsPlaySound: true,
  popoutWindowShortcut: 'Alt+Shift+Space',
  popoutWindowProjectlessDefaultEnabled: false,
  friendlyTaskTitlesEnabled: false,
  friendlyTaskTitleModel: null,
  quickPhrases: [],
  supervisorPrinciples: '',
  supervisorModelSelection: null,
  supervisorIntervalSeconds: 30,
  localHarnesses: [],
}

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const applyLanguagePreferenceMock = vi.hoisted(() => vi.fn())
const translateMock = vi.hoisted(
  () => (key: string, fallback?: string, options?: { modelName?: string }) => {
    if (key === 'workbench.friendly_task_titles_model_unavailable') {
      return `${options?.modelName ?? ''}（不可用）`
    }
    return fallback ?? key
  }
)
const importExternalContentMock = vi.hoisted(() => vi.fn())
const getWegentUsageDisplayMock = vi.hoisted(() => vi.fn())
const getRuntimeSettingsMock = vi.hoisted(() => vi.fn())
const updateRuntimeSettingsMock = vi.hoisted(() => vi.fn())
const refreshWorkListsMock = vi.hoisted(() => vi.fn())
const changeWorkbenchModeMock = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translateMock,
  }),
}))

vi.mock('@/desktop/appPreferences', () => ({
  defaultAppPreferences: {
    workbenchMode: 'developer',
    appearanceMode: 'system',
    appearanceThemeSnapshot: null,
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
    experimentalFeaturesEnabled: false,
    telemetryConsentAsked: true,
    telemetryEnabled: true,
    telemetryConsentRevision: 0,
    performanceRecordingEnabled: false,
    trayUnreadEnabled: true,
    trayRunningEnabled: true,
    trayUsageEnabled: true,
    trayWegentUsageEnabled: true,
    localCodexSubscriptionEnabled: true,
    browserExternalLinkTarget: 'system',
    browserLocalLinkTarget: 'wework',
    browserDownloadDirectory: null,
    browserFullControl: false,
    browserAskBeforeDownload: false,
    appshotsPlaySound: true,
    popoutWindowShortcut: 'Alt+Shift+Space',
    popoutWindowProjectlessDefaultEnabled: false,
    friendlyTaskTitlesEnabled: false,
    friendlyTaskTitleModel: null,
    quickPhrases: [],
    supervisorPrinciples: '',
    supervisorModelSelection: null,
    supervisorIntervalSeconds: 30,
    localHarnesses: [],
  },
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
}))

vi.mock('@/features/workbench-mode/workbenchMode', () => ({
  changeWorkbenchMode: changeWorkbenchModeMock,
}))

vi.mock('@/i18n/languagePreference', () => ({
  applyLanguagePreference: applyLanguagePreferenceMock,
  languagePreferenceOptions: [
    {
      value: 'system',
      labelKey: 'general_settings_language_system',
      shortLabelKey: 'general_settings_language_system_short',
      descriptionKey: 'general_settings_language_system_description',
    },
    {
      value: 'zh-CN',
      labelKey: 'general_settings_language_zh_cn',
      shortLabelKey: 'general_settings_language_zh_cn_short',
      descriptionKey: 'general_settings_language_zh_cn_description',
    },
    {
      value: 'en',
      labelKey: 'general_settings_language_en',
      shortLabelKey: 'general_settings_language_en_short',
      descriptionKey: 'general_settings_language_en_description',
    },
  ],
}))

vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: () => ({
    importExternalContent: importExternalContentMock,
  }),
}))

vi.mock('@/api/wegentUsage', () => ({
  getWegentUsageDisplay: getWegentUsageDisplayMock,
}))

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({
    isConnected: true,
    apiBaseUrl: 'https://wegent.example.com/api',
    token: 'token',
    serviceKey: 'test-cloud',
  }),
}))

describe('GeneralSettingsPage', () => {
  beforeEach(() => {
    setSessionTelemetryConsent(undefined)
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    applyLanguagePreferenceMock.mockReset()
    importExternalContentMock.mockReset()
    getWegentUsageDisplayMock.mockReset()
    getRuntimeSettingsMock.mockReset()
    updateRuntimeSettingsMock.mockReset()
    refreshWorkListsMock.mockReset()
    changeWorkbenchModeMock.mockReset()
    importExternalContentMock.mockResolvedValue({
      source: 'codex',
      sourcePath: '/Users/test/.codex',
      destinationPath: '/Users/test/.wework/codex',
      importedEntries: ['config.toml'],
    })
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    getRuntimeSettingsMock.mockResolvedValue({
      maxConcurrentTasks: 3,
      maxConcurrentStandInTasks: 4,
      maxConcurrentAgentTasks: 6,
    })
    updateRuntimeSettingsMock.mockImplementation(settings => Promise.resolve(settings))
    refreshWorkListsMock.mockResolvedValue(undefined)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
    )
    changeWorkbenchModeMock.mockImplementation(workbenchMode =>
      Promise.resolve({ ...defaultPreferences, workbenchMode })
    )
    applyLanguagePreferenceMock.mockResolvedValue('zh-CN')
    getWegentUsageDisplayMock.mockResolvedValue({
      status: 'available',
      sourceText: 'AIGC额度',
      sourceLabel: 'AIGC',
      quota: 1042,
      usage: 1127.68,
      remaining: -85.68,
      usageRate: 108.22,
      value: '1,127.68 / 1,042 元',
      detail: '已用 108.22% · 剩余 -85.68 元',
      trayTitle: 'AIGC -85.68',
      tooltip: 'AIGC额度\n1,127.68 / 1,042 元 (108.22%)\n剩余 -85.68 元',
    })
  })

  test('switches from developer mode to focus mode', async () => {
    render(<GeneralSettingsPage />)

    const focusButton = await screen.findByTestId('general-workbench-mode-focus-button')
    await waitFor(() => expect(focusButton).toBeEnabled())
    const developerButton = screen.getByTestId('general-workbench-mode-developer-button')
    expect(developerButton).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(developerButton)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(focusButton)
    expect(changeWorkbenchModeMock).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'workbench.general_settings_mode_focus_confirm_title'
    )
    await userEvent.click(screen.getByTestId('general-workbench-mode-confirm-button'))

    await waitFor(() => {
      expect(changeWorkbenchModeMock).toHaveBeenCalledWith('focus')
    })
    expect(focusButton).toHaveAttribute('aria-pressed', 'true')
  })

  test('keeps developer mode when a mode switch is cancelled', async () => {
    render(<GeneralSettingsPage />)

    const focusButton = await screen.findByTestId('general-workbench-mode-focus-button')
    await waitFor(() => expect(focusButton).toBeEnabled())
    await userEvent.click(focusButton)
    await userEvent.click(screen.getByTestId('general-workbench-mode-confirm-button-cancel-button'))

    expect(changeWorkbenchModeMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('general-workbench-mode-developer-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  test('refreshes the persisted mode when a failed switch cannot confirm rollback', async () => {
    getAppPreferencesMock
      .mockResolvedValueOnce(defaultPreferences)
      .mockResolvedValueOnce({ ...defaultPreferences, workbenchMode: 'focus' })
    changeWorkbenchModeMock.mockRejectedValue(
      new AggregateError([new Error('restart failed'), new Error('rollback failed')])
    )
    render(<GeneralSettingsPage />)

    const focusButton = await screen.findByTestId('general-workbench-mode-focus-button')
    await waitFor(() => expect(focusButton).toBeEnabled())
    await userEvent.click(focusButton)
    await userEvent.click(screen.getByTestId('general-workbench-mode-confirm-button'))

    await waitFor(() => expect(getAppPreferencesMock).toHaveBeenCalledTimes(2))
    expect(focusButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('general-workbench-mode-developer-button')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  test.each([
    ['general-max-concurrent-tasks-select', 'maxConcurrentTasks', 5],
    ['general-max-concurrent-stand-in-tasks-select', 'maxConcurrentStandInTasks', 7],
    ['general-max-concurrent-agent-tasks-select', 'maxConcurrentAgentTasks', 9],
  ])('loads and updates the independent limit %s', async (testId, key, initial) => {
    getRuntimeSettingsMock.mockResolvedValue({
      maxConcurrentTasks: 5,
      maxConcurrentStandInTasks: 7,
      maxConcurrentAgentTasks: 9,
    })
    render(
      <WorkbenchContext.Provider
        value={
          {
            projectChat: { models: [], requestCatalogs: vi.fn() },
            services: {
              runtimeWorkApi: {
                getRuntimeSettings: getRuntimeSettingsMock,
                updateRuntimeSettings: updateRuntimeSettingsMock,
              },
            },
            refreshWorkLists: refreshWorkListsMock,
          } as unknown as WorkbenchContextValue
        }
      >
        <GeneralSettingsPage />
      </WorkbenchContext.Provider>
    )

    const select = await screen.findByTestId(testId)
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue(String(initial))

    await userEvent.selectOptions(select, '2')

    await waitFor(() => {
      expect(updateRuntimeSettingsMock).toHaveBeenCalledWith({ [key]: 2 })
    })
    expect(refreshWorkListsMock).toHaveBeenCalledOnce()
    expect(select).toHaveValue('2')
    for (const [otherTestId, otherKey, otherValue] of [
      ['general-max-concurrent-tasks-select', 'maxConcurrentTasks', 5],
      ['general-max-concurrent-stand-in-tasks-select', 'maxConcurrentStandInTasks', 7],
      ['general-max-concurrent-agent-tasks-select', 'maxConcurrentAgentTasks', 9],
    ] as const) {
      if (otherKey !== key) expect(screen.getByTestId(otherTestId)).toHaveValue(String(otherValue))
    }
    updateRuntimeSettingsMock.mockRejectedValueOnce(new Error('persist failed'))
    await userEvent.selectOptions(select, '4')
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue('2')
  })

  test('isolates runtime loading and supports recovery without blocking other settings', async () => {
    getRuntimeSettingsMock.mockRejectedValueOnce(new Error('runtime unavailable'))
    render(
      <WorkbenchContext.Provider
        value={
          {
            services: {
              runtimeWorkApi: {
                getRuntimeSettings: getRuntimeSettingsMock,
                updateRuntimeSettings: updateRuntimeSettingsMock,
              },
            },
          } as unknown as WorkbenchContextValue
        }
      >
        <GeneralSettingsPage />
      </WorkbenchContext.Provider>
    )
    const retry = await screen.findByTestId('general-concurrency-retry-button')
    expect(screen.getByTestId('general-max-concurrent-tasks-select')).toBeDisabled()
    expect(screen.getByTestId('general-workbench-mode-developer-button')).toBeEnabled()
    await userEvent.click(retry)
    await waitFor(() =>
      expect(screen.getByTestId('general-max-concurrent-agent-tasks-select')).toBeEnabled()
    )
    expect(screen.getByTestId('general-max-concurrent-agent-tasks-select')).toHaveValue('6')
    expect(screen.queryByTestId('general-concurrency-retry-button')).not.toBeInTheDocument()
  })

  test('does not offer a concurrency save without a Runtime API', async () => {
    render(<RuntimeConcurrencySettings />)
    await waitFor(() =>
      expect(screen.getByTestId('general-max-concurrent-tasks-select')).toBeDisabled()
    )
    expect(updateRuntimeSettingsMock).not.toHaveBeenCalled()
  })

  test('saves the message send shortcut as a user preference', async () => {
    const updateUserPreferences = vi.fn().mockResolvedValue({ send_key: 'cmd_enter' as const })
    const renderSettings = (sendKey: 'enter' | 'cmd_enter') => (
      <WorkbenchContext.Provider
        value={
          {
            projectChat: { models: [], requestCatalogs: vi.fn() },
            services: {},
            state: {
              user: {
                id: 1,
                user_name: 'alice',
                email: 'alice@example.com',
                preferences: { send_key: sendKey },
              },
            },
            updateUserPreferences,
          } as unknown as WorkbenchContextValue
        }
      >
        <GeneralSettingsPage />
      </WorkbenchContext.Provider>
    )
    const rendered = render(renderSettings('enter'))

    const commandEnterButton = await screen.findByTestId('general-send-key-cmd_enter-button')
    await waitFor(() => expect(commandEnterButton).toBeEnabled())
    await userEvent.click(commandEnterButton)

    await waitFor(() => {
      expect(updateUserPreferences).toHaveBeenCalledWith({ send_key: 'cmd_enter' })
    })
    rendered.rerender(renderSettings('cmd_enter'))
    expect(commandEnterButton).toHaveAttribute('aria-pressed', 'true')
  })

  test('restores the previous send shortcut when saving fails', async () => {
    const updateUserPreferences = vi.fn().mockRejectedValue(new Error('save failed'))
    render(
      <WorkbenchContext.Provider
        value={
          {
            projectChat: { models: [], requestCatalogs: vi.fn() },
            services: {},
            state: {
              user: {
                id: 1,
                user_name: 'alice',
                email: 'alice@example.com',
                preferences: { send_key: 'enter' },
              },
            },
            updateUserPreferences,
          } as unknown as WorkbenchContextValue
        }
      >
        <GeneralSettingsPage />
      </WorkbenchContext.Provider>
    )

    const enterButton = await screen.findByTestId('general-send-key-enter-button')
    const commandEnterButton = screen.getByTestId('general-send-key-cmd_enter-button')
    await waitFor(() => expect(commandEnterButton).toBeEnabled())
    await userEvent.click(commandEnterButton)

    await waitFor(() => expect(enterButton).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('workbench.general_settings_send_key_save_failed')).toBeInTheDocument()
  })

  test('persists the selected startup workspace tab', async () => {
    getAppPreferencesMock.mockResolvedValue({
      ...defaultPreferences,
      experimentalFeaturesEnabled: true,
    })
    render(<GeneralSettingsPage />)

    const boardButton = await screen.findByTestId('general-fixed-tab-startup-fixed-board')
    await waitFor(() => expect(boardButton).toBeEnabled())
    expect(screen.getByTestId('general-fixed-tab-startup-fixed-task')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await userEvent.click(boardButton)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        fixedWorkspaceTabs: defaultPreferences.fixedWorkspaceTabs,
        startupWorkspaceTabId: 'fixed-board',
      })
    })
    expect(boardButton).toHaveAttribute('aria-pressed', 'true')
  })

  test('shows an unavailable saved friendly title model for replacement', async () => {
    const taskModel = {
      name: 'gpt-5',
      type: 'runtime',
      displayName: 'GPT-5',
    }
    getAppPreferencesMock.mockResolvedValue({
      ...defaultPreferences,
      friendlyTaskTitlesEnabled: true,
      friendlyTaskTitleModel: {
        modelName: 'removed-model',
        modelType: 'runtime',
        executionModelId: 'removed-model',
        executionModelType: 'runtime',
      },
    })

    render(
      <WorkbenchContext.Provider
        value={
          {
            projectChat: {
              models: [taskModel],
              selectedModel: taskModel,
            },
          } as unknown as WorkbenchContextValue
        }
      >
        <GeneralSettingsPage />
      </WorkbenchContext.Provider>
    )

    const modelSelect = await screen.findByTestId('friendly-task-title-model-select')
    expect(
      (
        within(modelSelect).getByRole('option', {
          name: 'removed-model（不可用）',
        }) as HTMLOptionElement
      ).selected
    ).toBe(true)
  })

  test('prevents sleep during tasks by default and persists disabling it', async () => {
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-prevent-sleep-while-tasks-running-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        preventSleepWhileTasksRunning: false,
      })
    })
  })

  test('keeps performance recording off by default and persists enabling it', async () => {
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-performance-recording-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ performanceRecordingEnabled: true })
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })
  })

  test('shows a saved performance recording preference and persists disabling it', async () => {
    getAppPreferencesMock.mockResolvedValue({
      ...defaultPreferences,
      performanceRecordingEnabled: true,
    })
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-performance-recording-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ performanceRecordingEnabled: false })
      expect(toggle).toHaveAttribute('aria-checked', 'false')
    })
  })

  test('restores the performance recording toggle when saving fails', async () => {
    updateAppPreferencesMock.mockRejectedValue(new Error('save failed'))
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-performance-recording-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    await userEvent.click(toggle)

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      expect(screen.getByTestId('general-settings-status')).toHaveTextContent(
        'workbench.general_settings_save_failed'
      )
    })
  })

  test('persists telemetry changes as an explicit consent decision', async () => {
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-telemetry-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith(
        {
          telemetryConsentAsked: true,
          telemetryEnabled: false,
        },
        expect.any(Number)
      )
    })
  })

  test('records, clears, and persists the Popout Window shortcut', async () => {
    render(<GeneralSettingsPage />)

    const recordButton = await screen.findByTestId('general-popout-shortcut-record-button')
    await waitFor(() => expect(recordButton).toBeEnabled())
    await userEvent.click(recordButton)
    fireEvent.keyDown(window, { key: 'Alt', altKey: true })
    fireEvent.keyDown(window, {
      key: '',
      code: 'ShiftLeft',
      altKey: true,
      shiftKey: true,
    })

    expect(updateAppPreferencesMock).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: ' ', altKey: true, shiftKey: true })

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        popoutWindowShortcut: 'Alt+Shift+Space',
      })
    })

    await userEvent.click(screen.getByTestId('general-popout-shortcut-clear-button'))
    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ popoutWindowShortcut: null })
    })
  })

  test('rolls back language selection when saving fails', async () => {
    getAppPreferencesMock.mockResolvedValue({ ...defaultPreferences, language: 'zh-CN' })
    updateAppPreferencesMock.mockRejectedValue(new Error('save failed'))

    render(<GeneralSettingsPage />)

    const zhButton = await screen.findByTestId('general-language-zh-CN-button')
    const englishButton = screen.getByTestId('general-language-en-button')
    await waitFor(() => expect(englishButton).toBeEnabled())
    fireEvent.click(englishButton)

    await waitFor(() => {
      expect(screen.getByTestId('general-settings-status')).toHaveTextContent(
        'workbench.general_settings_save_failed'
      )
    })
    expect(zhButton).toHaveAttribute('aria-pressed', 'true')
    expect(zhButton.className).toContain('bg-text-primary')
    expect(applyLanguagePreferenceMock).not.toHaveBeenCalled()
  })

  test('shows an import error and allows retrying', async () => {
    importExternalContentMock
      .mockRejectedValueOnce(new Error('No supported content was found'))
      .mockResolvedValueOnce({
        source: 'codex',
        sourcePath: '/Users/test/.codex',
        destinationPath: '/Users/test/.wework/codex',
        importedEntries: ['config.toml'],
      })
    render(<GeneralSettingsPage />)

    await userEvent.click(await screen.findByTestId('general-external-content-import-button'))
    await userEvent.click(screen.getByTestId('external-content-import-confirm-button'))
    expect(await screen.findByTestId('external-content-import-error')).toHaveTextContent(
      'No supported content was found'
    )

    await userEvent.click(screen.getByTestId('external-content-import-confirm-button'))
    expect(await screen.findByTestId('external-content-import-success')).toBeInTheDocument()
    expect(importExternalContentMock).toHaveBeenCalledTimes(2)
  })
})
