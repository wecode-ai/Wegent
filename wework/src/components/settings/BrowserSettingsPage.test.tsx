import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppPreferences } from '@/desktop/appPreferences'
import './../../../src/i18n'
import { BrowserSettingsPage } from './BrowserSettingsPage'

const getAppPreferencesMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const clearEmbeddedBrowserDataMock = vi.hoisted(() => vi.fn())
const openNativeDirectoryPickerMock = vi.hoisted(() => vi.fn())

const preferences: AppPreferences = vi.hoisted(() => ({
  closeToTrayEnabled: true,
  showMainWindowOnLaunch: true,
  systemDragEnabled: true,
  preventSleepWhileTasksRunning: true,
  closeToTrayHintSeen: false,
  language: 'zh-CN',
  terminalContextInjectionEnabled: true,
  contextCompactionThreshold: 85,
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
}))

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return {
    ...actual,
    defaultAppPreferences: preferences,
    getAppPreferences: getAppPreferencesMock,
    updateAppPreferences: updateAppPreferencesMock,
  }
})

vi.mock('@/lib/embedded-browser', () => ({
  canUseEmbeddedBrowser: () => true,
  clearEmbeddedBrowserData: clearEmbeddedBrowserDataMock,
}))

vi.mock('@/lib/native-directory-picker', () => ({
  openNativeDirectoryPicker: openNativeDirectoryPickerMock,
}))

const navigateToMock = vi.hoisted(() => vi.fn())
const searchHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/navigation', () => ({
  navigateTo: navigateToMock,
  toBrowserPath: (path: string) => path,
}))

vi.mock('@/lib/embedded-browser-history', () => ({
  searchEmbeddedBrowserHistory: searchHistoryMock,
  removeEmbeddedBrowserHistoryEntries: vi.fn(),
  embeddedBrowserHistoryEntryKey: (entry: { id: string }) => entry.id,
  embeddedBrowserHistoryNextCursor: vi.fn(() => null),
}))

describe('BrowserSettingsPage', () => {
  beforeEach(() => {
    getAppPreferencesMock.mockReset()
    updateAppPreferencesMock.mockReset()
    clearEmbeddedBrowserDataMock.mockReset()
    openNativeDirectoryPickerMock.mockReset()
    getAppPreferencesMock.mockResolvedValue(preferences)
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...preferences, ...patch })
    )
    clearEmbeddedBrowserDataMock.mockResolvedValue(1)
    openNativeDirectoryPickerMock.mockResolvedValue(null)
    navigateToMock.mockReset()
    searchHistoryMock.mockReset()
    searchHistoryMock.mockResolvedValue([])
  })

  test('renders configured link targets without implementation notices', async () => {
    render(<BrowserSettingsPage />)

    expect(await screen.findByTestId('browser-external-link-target')).toHaveValue('system')
    expect(screen.getByTestId('browser-local-link-target')).toHaveValue('wework')
    expect(screen.queryByText('Wework 内置浏览器可用')).not.toBeInTheDocument()
    expect(screen.queryByText('Google Chrome 个人资料')).not.toBeInTheDocument()
  })

  test('saves link routing and download prompt preferences', async () => {
    render(<BrowserSettingsPage />)
    const externalTarget = await screen.findByTestId('browser-external-link-target')
    await waitFor(() => expect(externalTarget).toBeEnabled())

    await userEvent.selectOptions(externalTarget, 'wework')
    await waitFor(() =>
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        browserExternalLinkTarget: 'wework',
      })
    )

    const askToggle = screen.getByTestId('browser-ask-before-download-toggle')
    await waitFor(() => expect(askToggle).toBeEnabled())
    await userEvent.click(askToggle)
    await waitFor(() =>
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        browserAskBeforeDownload: true,
      })
    )
  })

  test('selects and resets the browser download directory', async () => {
    openNativeDirectoryPickerMock.mockResolvedValue('/tmp/browser-downloads')
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ ...preferences, ...patch })
    )
    render(<BrowserSettingsPage />)

    const changeButton = await screen.findByTestId('browser-download-location-change')
    await waitFor(() => expect(changeButton).toBeEnabled())
    await userEvent.click(changeButton)

    await waitFor(() => {
      expect(openNativeDirectoryPickerMock).toHaveBeenCalledWith(undefined)
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        browserDownloadDirectory: '/tmp/browser-downloads',
      })
    })

    const resetButton = await screen.findByTestId('browser-download-location-reset')
    await userEvent.click(resetButton)
    await waitFor(() =>
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({ browserDownloadDirectory: null })
    )
  })

  test('requires confirmation before clearing browser data', async () => {
    render(<BrowserSettingsPage />)

    const clearButton = await screen.findByTestId('browser-clear-data-button')
    await waitFor(() => expect(clearButton).toBeEnabled())
    await userEvent.click(clearButton)
    expect(screen.getByTestId('browser-clear-data-dialog')).toBeInTheDocument()
    expect(clearEmbeddedBrowserDataMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('browser-clear-data-confirm'))

    await waitFor(() => expect(clearEmbeddedBrowserDataMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('browser-settings-status')).toHaveTextContent(
      '内置浏览器数据已清除'
    )
  })

  test('navigates to the browsing history page from the general section', async () => {
    render(<BrowserSettingsPage />)

    const manageButton = await screen.findByTestId('browser-history-manage-button')
    await waitFor(() => expect(manageButton).toBeEnabled())
    await userEvent.click(manageButton)

    expect(navigateToMock).toHaveBeenCalledWith('/settings/browser/history')
  })

  test('renders the browsing history subview on the history path', async () => {
    searchHistoryMock.mockResolvedValue([])
    window.history.pushState({}, '', '/settings/browser/history')
    render(<BrowserSettingsPage />)

    expect(await screen.findByTestId('browser-history-page')).toBeInTheDocument()
    expect(await screen.findByTestId('browser-history-empty')).toBeInTheDocument()
    window.history.pushState({}, '', '/')
  })
})
