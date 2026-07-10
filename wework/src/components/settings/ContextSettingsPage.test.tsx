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
}

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
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

describe('ContextSettingsPage', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(defaultPreferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...defaultPreferences, ...patch })
    )
  })

  test('saves terminal context injection preference', async () => {
    render(<ContextSettingsPage />)

    const toggle = await screen.findByTestId('context-terminal-injection-toggle')
    expect(toggle).toBeChecked()

    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        terminalContextInjectionEnabled: false,
      })
    })
    expect(toggle).not.toBeChecked()
  })
})
