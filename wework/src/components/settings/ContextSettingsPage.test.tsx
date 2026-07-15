import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/tauri/appPreferences'
import { ContextSettingsPage } from './ContextSettingsPage'

const defaultPreferences: AppPreferences = {
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  taskCompletionNotificationsEnabled: false,
  trayUnreadEnabled: true,
  trayRunningEnabled: true,
  trayUsageEnabled: true,
  browserExternalLinkTarget: 'system',
  browserLocalLinkTarget: 'wework',
  browserDownloadDirectory: null,
  browserAskBeforeDownload: false,
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

vi.mock('@/tauri/appPreferences', () => ({
  defaultAppPreferences: {
    closeToTrayEnabled: true,
    showMainWindowOnLaunch: true,
    closeToTrayHintSeen: false,
    language: 'zh-CN',
    terminalContextInjectionEnabled: true,
    taskCompletionNotificationsEnabled: false,
    trayUnreadEnabled: true,
    trayRunningEnabled: true,
    trayUsageEnabled: true,
  },
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
})
