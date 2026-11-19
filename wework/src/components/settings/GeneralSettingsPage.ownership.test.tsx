import i18n from '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultAppPreferences, type AppPreferences } from '@/desktop/appPreferences'
import {
  AppPreferencesContext,
  type AppPreferencesState,
} from '@/features/app-preferences/appPreferencesContext'
import { setSessionTelemetryConsent } from '@/telemetry/sessionConsent'
import { GeneralSettingsPage } from './GeneralSettingsPage'

const host = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), apps: vi.fn(), quota: vi.fn() }))
const cloud = vi.hoisted(() => ({
  isConnected: true,
  apiBaseUrl: 'https://api.example.test',
  token: 'first',
  serviceKey: 'first',
  user: { id: 7 },
}))
vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: host.get,
  updateAppPreferences: host.update,
}))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => cloud,
}))
vi.mock('@/api/wegentUsage', () => ({ getWegentUsageDisplay: host.quota }))
vi.mock('@/api/local/harnessApps', () => ({ harnessAppsApi: { list: host.apps } }))
vi.mock('./DefaultRunnerSetting', () => ({ DefaultRunnerSetting: () => null }))
vi.mock('./ReplyPredictionSettings', () => ({ ReplyPredictionSettings: () => null }))
vi.mock('./RuntimeConcurrencySettings', () => ({ RuntimeConcurrencySettings: () => null }))
vi.mock('@/features/dsh-runtime/DshSettingsSectionSurface', () => ({
  DshSettingsSectionSurface: () => null,
}))
function provider(value: AppPreferencesState) {
  return (
    <AppPreferencesContext.Provider value={value}>
      <GeneralSettingsPage />
    </AppPreferencesContext.Provider>
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
let preferences: AppPreferences
beforeEach(() => {
  setSessionTelemetryConsent(undefined)
  preferences = { ...defaultAppPreferences }
  host.get.mockReset().mockImplementation(async () => preferences)
  host.update.mockReset().mockImplementation(async patch => {
    preferences = { ...preferences, ...patch }
    return preferences
  })
  host.apps.mockReset().mockResolvedValue([])
  host.quota.mockReset().mockResolvedValue({ status: 'available', sourceText: 'First quota' })
  cloud.isConnected = true
  cloud.token = 'first'
  cloud.serviceKey = 'first'
  cloud.user = { id: 7 }
})

test('uses a ready preference provider directly without another native read', async () => {
  const { rerender } = render(provider({ preferences, loaded: true }))
  expect(screen.getByTestId('general-close-to-tray-toggle')).toBeEnabled()
  rerender(provider({ preferences, loaded: true }))
  await act(async () => {})
  expect(host.get).not.toHaveBeenCalled()
})

test('waits for an existing provider rather than starting an independent preference read', async () => {
  const { rerender } = render(provider({ preferences, loaded: false }))
  expect(screen.getByTestId('general-close-to-tray-toggle')).toBeDisabled()
  expect(host.get).not.toHaveBeenCalled()
  preferences = { ...preferences, closeToTrayEnabled: false }
  rerender(provider({ preferences, loaded: true }))
  expect(screen.getByTestId('general-close-to-tray-toggle')).toHaveAttribute(
    'aria-checked',
    'false'
  )
  expect(screen.getByTestId('general-close-to-tray-toggle')).toBeEnabled()
})

test('adopts external provider updates without writing them back', () => {
  const { rerender } = render(provider({ preferences, loaded: true }))
  rerender(
    provider({ preferences: { ...preferences, showMainWindowOnLaunch: false }, loaded: true })
  )
  expect(screen.getByTestId('general-show-main-window-on-launch-toggle')).toHaveAttribute(
    'aria-checked',
    'false'
  )
  expect(host.get).not.toHaveBeenCalled()
  expect(host.update).not.toHaveBeenCalled()
})

test('does not refetch preferences or quota on a language change after a successful save', async () => {
  render(<GeneralSettingsPage />)
  const toggle = screen.getByTestId('general-close-to-tray-toggle')
  await waitFor(() => expect(toggle).toBeEnabled())
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeEnabled())
  const saved = toggle.getAttribute('aria-checked')
  const previousLanguage = i18n.language
  try {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(toggle).toHaveAttribute('aria-checked', saved)
    expect(host.get).toHaveBeenCalledTimes(1)
    expect(host.quota).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('exposes a preference read retry and recovers without persisting defaults', async () => {
  host.get.mockRejectedValueOnce(new Error('Native preferences unavailable'))
  render(<GeneralSettingsPage />)
  await screen.findByTestId('general-settings-retry')
  expect(host.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('general-settings-retry'))
  await waitFor(() =>
    expect(screen.queryByTestId('general-settings-retry')).not.toBeInTheDocument()
  )
  expect(host.get).toHaveBeenCalledTimes(2)
  expect(host.update).not.toHaveBeenCalled()
})

test('does not load optional Smart apps before experimental features are enabled', async () => {
  const { rerender } = render(provider({ preferences, loaded: true }))
  await act(async () => {})
  expect(host.apps).not.toHaveBeenCalled()
  rerender(
    provider({ preferences: { ...preferences, experimentalFeaturesEnabled: true }, loaded: true })
  )
  await waitFor(() => expect(host.apps).toHaveBeenCalledTimes(1))
})

test('isolates a pending or failed Smart app inventory from general switches and retries locally', async () => {
  const pending = deferred<[]>()
  host.apps
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error('Inventory unavailable'))
    .mockResolvedValue([])
  const experimental = { ...preferences, experimentalFeaturesEnabled: true }
  const { rerender } = render(provider({ preferences: experimental, loaded: true }))
  expect(screen.getByTestId('general-close-to-tray-toggle')).toBeEnabled()
  await act(async () => pending.resolve([]))
  rerender(provider({ preferences, loaded: true }))
  rerender(provider({ preferences: experimental, loaded: true }))
  await screen.findByTestId('general-smart-apps-error')
  expect(screen.getByTestId('general-close-to-tray-toggle')).toBeEnabled()
  fireEvent.click(screen.getByTestId('general-smart-apps-retry'))
  await waitFor(() =>
    expect(screen.queryByTestId('general-smart-apps-error')).not.toBeInTheDocument()
  )
  expect(host.apps).toHaveBeenCalledTimes(3)
  expect(host.update).not.toHaveBeenCalled()
})

test('does not publish quota metadata from an old cloud owner', async () => {
  const old = deferred<{ status: string; sourceText: string }>()
  host.quota
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ status: 'available', sourceText: 'Current quota' })
  const { rerender } = render(provider({ preferences, loaded: true }))
  await waitFor(() => expect(host.quota).toHaveBeenCalledTimes(1))
  cloud.token = 'current'
  cloud.serviceKey = 'current'
  rerender(provider({ preferences, loaded: true }))
  await screen.findByText('Current quota')
  await act(async () => old.resolve({ status: 'available', sourceText: 'Private old quota' }))
  expect(screen.queryByText('Private old quota')).not.toBeInTheDocument()
  expect(screen.getByText('Current quota')).toBeInTheDocument()
})

test('does not load quota while disconnected', async () => {
  cloud.isConnected = false
  render(provider({ preferences, loaded: true }))
  await act(async () => {})
  expect(host.quota).not.toHaveBeenCalled()
})

test('releases the native shortcut recorder on Escape and after unmount', async () => {
  const { unmount } = render(provider({ preferences, loaded: true }))
  fireEvent.click(screen.getByTestId('general-popout-shortcut-record-button'))
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true })
  expect(host.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('general-popout-shortcut-record-button'))
  unmount()
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true, shiftKey: true })
  expect(host.update).not.toHaveBeenCalled()
})

test('revalidates the native source when a preference provider releases ownership', async () => {
  const view = (value: AppPreferencesState | null) => (
    <AppPreferencesContext.Provider value={value}>
      <GeneralSettingsPage />
    </AppPreferencesContext.Provider>
  )
  const { rerender } = render(view(null))
  await waitFor(() => expect(host.get).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByTestId('general-close-to-tray-toggle')).toBeEnabled())
  rerender(view({ preferences: { ...preferences, closeToTrayEnabled: true }, loaded: true }))
  preferences = { ...preferences, closeToTrayEnabled: false }
  rerender(view(null))
  await waitFor(() => expect(host.get).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(screen.getByTestId('general-close-to-tray-toggle')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  )
})
