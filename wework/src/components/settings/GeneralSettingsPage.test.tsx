import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/tauri/appPreferences'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { GeneralSettingsPage } from './GeneralSettingsPage'

const defaultPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  defaultWorkspaceTab: 'task',
  systemDragEnabled: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  contextCompactionThreshold: 85,
  experimentalFeaturesEnabled: false,
  telemetryConsentAsked: true,
  telemetryEnabled: true,
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
  popoutWindowShortcut: 'Alt+Shift+Space',
  popoutWindowProjectlessDefaultEnabled: false,
  friendlyTaskTitlesEnabled: false,
  friendlyTaskTitleModel: null,
  quickPhrases: [],
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

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translateMock,
  }),
}))

vi.mock('@/tauri/appPreferences', () => ({
  defaultAppPreferences: {
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    defaultWorkspaceTab: 'task',
    systemDragEnabled: true,
    preventSleepWhileTasksRunning: true,
    closeToTrayHintSeen: false,
    language: 'zh-CN',
    terminalContextInjectionEnabled: true,
    experimentalFeaturesEnabled: false,
    telemetryConsentAsked: true,
    telemetryEnabled: true,
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
    popoutWindowShortcut: 'Alt+Shift+Space',
    popoutWindowProjectlessDefaultEnabled: false,
    friendlyTaskTitlesEnabled: false,
    friendlyTaskTitleModel: null,
    quickPhrases: [],
  },
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
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
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    applyLanguagePreferenceMock.mockReset()
    importExternalContentMock.mockReset()
    getWegentUsageDisplayMock.mockReset()
    getRuntimeSettingsMock.mockReset()
    updateRuntimeSettingsMock.mockReset()
    importExternalContentMock.mockResolvedValue({
      source: 'codex',
      sourcePath: '/Users/test/.codex',
      destinationPath: '/Users/test/.wework/codex',
      importedEntries: ['config.toml'],
    })
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    getRuntimeSettingsMock.mockResolvedValue({ maxConcurrentTasks: 3 })
    updateRuntimeSettingsMock.mockImplementation(settings => Promise.resolve(settings))
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
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

  test('renders language preference options', async () => {
    render(<GeneralSettingsPage />)

    expect(await screen.findByTestId('general-language-system-button')).toBeInTheDocument()
    expect(screen.getByTestId('general-language-zh-CN-button')).toBeInTheDocument()
    expect(screen.getByTestId('general-language-en-button')).toBeInTheDocument()
  })

  test('loads and updates the maximum parallel task count', async () => {
    getRuntimeSettingsMock.mockResolvedValue({ maxConcurrentTasks: 5 })
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

    const select = await screen.findByTestId('general-max-concurrent-tasks-select')
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue('5')

    await userEvent.selectOptions(select, '2')

    await waitFor(() => {
      expect(updateRuntimeSettingsMock).toHaveBeenCalledWith({ maxConcurrentTasks: 2 })
    })
    expect(select).toHaveValue('2')
  })

  test('uses ten parallel tasks when runtime settings are unavailable', async () => {
    getRuntimeSettingsMock.mockResolvedValue(undefined)
    render(<GeneralSettingsPage />)

    const select = await screen.findByTestId('general-max-concurrent-tasks-select')
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue('10')
  })

  test('saves and applies the selected language', async () => {
    render(<GeneralSettingsPage />)

    const englishButton = await screen.findByTestId('general-language-en-button')
    await waitFor(() => expect(englishButton).toBeEnabled())
    fireEvent.click(englishButton)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ language: 'en' })
    })
    expect(applyLanguagePreferenceMock).toHaveBeenCalledWith('en')
  })

  test('persists the selected default workspace tab', async () => {
    render(<GeneralSettingsPage />)

    const boardButton = await screen.findByTestId('general-default-workspace-tab-board-button')
    await waitFor(() => expect(boardButton).toBeEnabled())
    expect(screen.getByTestId('general-default-workspace-tab-task-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await userEvent.click(boardButton)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        defaultWorkspaceTab: 'board',
      })
    })
    expect(boardButton).toHaveAttribute('aria-pressed', 'true')
  })

  test('keeps experimental features off by default and persists enabling them', async () => {
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-experimental-features-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ experimentalFeaturesEnabled: true })
    })
  })

  test('keeps friendly titles off by default and uses the task model when enabled', async () => {
    const taskModel = {
      name: 'gpt-5',
      type: 'runtime',
      displayName: 'GPT-5',
    }
    const workbench = {
      projectChat: {
        models: [taskModel],
        selectedModel: taskModel,
      },
    } as unknown as WorkbenchContextValue

    render(
      <WorkbenchContext.Provider value={workbench}>
        <GeneralSettingsPage />
      </WorkbenchContext.Provider>
    )

    const toggle = await screen.findByTestId('friendly-task-titles-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        friendlyTaskTitlesEnabled: true,
        friendlyTaskTitleModel: null,
      })
    })

    const modelSelect = screen.getByTestId('friendly-task-title-model-select')
    expect(
      (within(modelSelect).getByRole('option', { name: '与任务相同' }) as HTMLOptionElement)
        .selected
    ).toBe(true)
    expect(
      within(modelSelect).queryByRole('option', { name: '请选择模型' })
    ).not.toBeInTheDocument()
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

  test('enables the system drag panel by default and persists disabling it', async () => {
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-system-drag-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ systemDragEnabled: false })
    })
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

  test('persists telemetry changes as an explicit consent decision', async () => {
    render(<GeneralSettingsPage />)

    const toggle = await screen.findByTestId('general-telemetry-toggle')
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        telemetryConsentAsked: true,
        telemetryEnabled: false,
      })
    })
  })

  test('groups task runtime controls separately and spaces later sections', async () => {
    render(<GeneralSettingsPage />)

    const basicSection = screen.getByTestId('general-settings-basic-section')
    const runtimeSection = screen.getByTestId('general-settings-runtime-section')
    const privacySection = screen.getByTestId('general-settings-privacy-section')
    const popoutSection = screen.getByTestId('general-settings-popout-section')

    expect(runtimeSection).toHaveClass('mt-12')
    expect(privacySection).toHaveClass('mt-12')
    expect(popoutSection).toHaveClass('mt-12')
    expect(within(runtimeSection).getByTestId('general-close-to-tray-toggle')).toBeInTheDocument()
    expect(
      within(runtimeSection).getByTestId('general-prevent-sleep-while-tasks-running-toggle')
    ).toBeInTheDocument()
    expect(
      within(runtimeSection).getByTestId('general-task-completion-notifications-toggle')
    ).toBeInTheDocument()
    expect(within(runtimeSection).getByTestId('general-tray-running-toggle')).toBeInTheDocument()
    expect(
      within(basicSection).queryByTestId('general-close-to-tray-toggle')
    ).not.toBeInTheDocument()
    expect(within(basicSection).queryByTestId('general-system-drag-toggle')).not.toBeInTheDocument()
    expect(within(popoutSection).getByTestId('general-system-drag-toggle')).toBeInTheDocument()
    expect(within(privacySection).getByTestId('general-telemetry-toggle')).toBeInTheDocument()
    expect(
      within(popoutSection).getByTestId('general-popout-shortcut-record-button')
    ).toBeInTheDocument()
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

  test('shows system tray toggles and saves each tray display preference separately', async () => {
    render(<GeneralSettingsPage />)

    expect(
      await screen.findByText('workbench.general_settings_tray_display_content')
    ).toBeInTheDocument()
    const notificationToggle = screen.getByTestId('general-task-completion-notifications-toggle')
    await waitFor(() => expect(notificationToggle).toBeEnabled())
    expect(notificationToggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('general-tray-unread-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('general-tray-running-toggle')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('general-tray-usage-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('general-tray-wegent-usage-toggle')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByText('workbench.general_settings_tray_usage')).toBeInTheDocument()
    expect(await screen.findByText('AIGC额度')).toBeInTheDocument()

    await userEvent.click(notificationToggle)
    await userEvent.click(screen.getByTestId('general-tray-unread-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-running-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-usage-toggle'))
    await userEvent.click(screen.getByTestId('general-tray-wegent-usage-toggle'))

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        taskCompletionNotificationsEnabled: true,
      })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayUnreadEnabled: false })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayRunningEnabled: false })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayUsageEnabled: false })
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ trayWegentUsageEnabled: false })
    })
  })

  test('imports compatible content from Codex and Claude Code', async () => {
    render(<GeneralSettingsPage />)

    await userEvent.click(await screen.findByTestId('general-external-content-import-button'))
    expect(screen.getByTestId('external-content-import-dialog')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('external-content-source-claude-code'))
    await userEvent.click(screen.getByTestId('external-content-import-confirm-button'))

    await waitFor(() => {
      expect(importExternalContentMock).toHaveBeenCalledWith('claude-code')
    })
    expect(screen.getByTestId('external-content-import-success')).toBeInTheDocument()
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
