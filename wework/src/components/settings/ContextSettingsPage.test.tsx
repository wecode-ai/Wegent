import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/desktop/appPreferences'
import { ContextSettingsPage } from './ContextSettingsPage'

const defaultPreferences: AppPreferences = {
  workbenchMode: 'developer',
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  systemDragEnabled: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  contextCompactionThreshold: 85,
  supervisorPrinciples: '',
  experimentalFeaturesEnabled: false,
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
}

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const getLocalCodexInstructionsMock = vi.hoisted(() => vi.fn())
const saveLocalCodexInstructionsMock = vi.hoisted(() => vi.fn())
const translateMock = vi.hoisted(() => (key: string, fallback?: string) => fallback ?? key)

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: translateMock,
  }),
}))

vi.mock('@/desktop/appPreferences', () => ({
  defaultAppPreferences: {
    workbenchMode: 'developer',
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    systemDragEnabled: true,
    preventSleepWhileTasksRunning: true,
    closeToTrayHintSeen: false,
    language: 'zh-CN',
    terminalContextInjectionEnabled: true,
    contextCompactionThreshold: 85,
    supervisorPrinciples: '',
    experimentalFeaturesEnabled: false,
    telemetryEnabled: true,
    taskCompletionNotificationsEnabled: false,
    trayUnreadEnabled: true,
    trayRunningEnabled: true,
    trayUsageEnabled: true,
    trayWegentUsageEnabled: true,
    appshotsPlaySound: true,
  },
  CONTEXT_COMPACTION_THRESHOLD_MIN: 1,
  CONTEXT_COMPACTION_THRESHOLD_MAX: 100,
  clampContextCompactionThreshold: (value: number) => Math.min(100, Math.max(1, Math.round(value))),
  getAppPreferences: getAppPreferencesMock,
  updateAppPreferences: updateAppPreferencesMock,
}))

vi.mock('@/api/local/codexInstructions', () => ({
  getLocalCodexInstructions: getLocalCodexInstructionsMock,
  saveLocalCodexInstructions: saveLocalCodexInstructionsMock,
}))

describe('ContextSettingsPage', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    getLocalCodexInstructionsMock.mockReset()
    saveLocalCodexInstructionsMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
    )
    getLocalCodexInstructionsMock.mockResolvedValue({
      instructions: 'Always answer in concise Chinese.',
      configPath: '/Users/example/.codex/config.toml',
    })
    saveLocalCodexInstructionsMock.mockImplementation((instructions: string) =>
      Promise.resolve({ instructions, configPath: '/Users/example/.codex/config.toml' })
    )
  })

  test('saves terminal context injection preference', async () => {
    render(<ContextSettingsPage />)

    const toggle = await screen.findByTestId('context-terminal-injection-toggle')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        terminalContextInjectionEnabled: false,
      })
    })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  test('saves the context compaction threshold', async () => {
    render(<ContextSettingsPage />)

    const input = await screen.findByTestId('context-compaction-threshold-input')
    expect(input).toHaveValue(85)
    await waitFor(() => expect(input).toBeEnabled())

    await userEvent.clear(input)
    await userEvent.type(input, '90{Enter}')

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ contextCompactionThreshold: 90 })
    })
    expect(input).toHaveValue(90)
  })

  test('rounds the full numeric input before saving the threshold', async () => {
    render(<ContextSettingsPage />)

    const input = await screen.findByTestId('context-compaction-threshold-input')
    fireEvent.change(input, { target: { value: '90.6' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ contextCompactionThreshold: 91 })
    })
  })

  test('loads and saves Wework custom instructions', async () => {
    render(<ContextSettingsPage />)

    const textarea = await screen.findByTestId('context-wework-instructions-textarea')
    expect(textarea).toHaveValue('Always answer in concise Chinese.')
    expect(screen.getByTestId('context-wework-instructions-save-button')).toBeDisabled()

    await userEvent.clear(textarea)
    await userEvent.type(textarea, 'Prefer TypeScript examples.')
    expect(screen.getByTestId('context-wework-instructions-save-button')).toBeEnabled()

    await userEvent.click(screen.getByTestId('context-wework-instructions-save-button'))

    await waitFor(() => {
      expect(saveLocalCodexInstructionsMock).toHaveBeenCalledWith('Prefer TypeScript examples.')
    })
    expect(screen.getByTestId('context-wework-instructions-save-button')).toBeDisabled()
  })

  test('hides supervisor principles without experimental features', async () => {
    render(<ContextSettingsPage />)

    await screen.findByTestId('context-terminal-injection-toggle')
    expect(screen.queryByTestId('context-supervisor-principles-textarea')).not.toBeInTheDocument()
  })

  test('shows and saves supervisor principles with experimental features', async () => {
    getAppPreferencesMock.mockResolvedValue({
      ...defaultPreferences,
      experimentalFeaturesEnabled: true,
    })
    render(<ContextSettingsPage />)

    const textarea = await screen.findByTestId('context-supervisor-principles-textarea')
    expect(textarea).toHaveValue('')
    expect(screen.getByTestId('context-supervisor-principles-save-button')).toBeDisabled()

    await userEvent.type(textarea, '发现偏离目标时先给出最小纠正建议。')
    await userEvent.click(screen.getByTestId('context-supervisor-principles-save-button'))

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        supervisorPrinciples: '发现偏离目标时先给出最小纠正建议。',
      })
    })
  })
})
