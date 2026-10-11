import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultAppPreferences } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { ModelSettingsPage } from './ModelSettingsPage'

const invokeDesktopHostMock = vi.hoisted(() => vi.fn())
const updateAppPreferencesMock = vi.hoisted(() => vi.fn())
const getLocalCodexAuthStatusMock = vi.hoisted(() => vi.fn())
const listLocalCodexAccountsMock = vi.hoisted(() => vi.fn())
const getLocalCodexOfficialModelsMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: invokeDesktopHostMock,
}))

vi.mock('@/desktop/appPreferences', async () => {
  const actual = await vi.importActual<typeof import('@/desktop/appPreferences')>(
    '@/desktop/appPreferences'
  )
  return {
    ...actual,
    defaultAppPreferences: { ...actual.defaultAppPreferences, localCodexSubscriptionEnabled: true },
    updateAppPreferences: updateAppPreferencesMock,
  }
})

vi.mock('@/api/local/runtimeAuthStatus', () => ({
  getLocalCodexAuthStatus: getLocalCodexAuthStatusMock,
}))

vi.mock('@/api/local/codexAuth', () => ({
  cancelLocalCodexLogin: vi.fn(),
  listLocalCodexAccounts: listLocalCodexAccountsMock,
  startLocalCodexLogin: vi.fn(),
  switchLocalCodexAccount: vi.fn(),
}))

vi.mock('@/api/local/codexOfficialModels', () => ({
  deleteLocalCodexModelCatalogOverride: vi.fn(),
  getLocalCodexModelCatalogOverrides: vi.fn().mockResolvedValue([]),
  getLocalCodexOfficialModels: getLocalCodexOfficialModelsMock,
  saveLocalCodexModelCatalogOverride: vi.fn(),
}))

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => ({ isConnected: false }),
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))

vi.mock('@/telemetry/client', () => ({ track: vi.fn() }))

describe('ModelSettingsPage local Codex subscription toggle', () => {
  beforeEach(() => {
    invokeDesktopHostMock.mockReset()
    updateAppPreferencesMock.mockReset()
    getLocalCodexAuthStatusMock.mockReset()
    listLocalCodexAccountsMock.mockReset()
    getLocalCodexOfficialModelsMock.mockReset()
    updateAppPreferencesMock.mockImplementation(patch =>
      Promise.resolve({ localCodexSubscriptionEnabled: true, ...patch })
    )
    getLocalCodexAuthStatusMock.mockResolvedValue({ exists: false })
    listLocalCodexAccountsMock.mockResolvedValue({ accounts: [], activeAccountId: null })
    getLocalCodexOfficialModelsMock.mockResolvedValue({ providers: [], models: [] })
  })

  test('opens the restart dialog and invokes app.relaunch on confirm', async () => {
    render(<ModelSettingsPage />)

    const toggle = await screen.findByTestId('local-codex-subscription-toggle')
    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        localCodexSubscriptionEnabled: false,
      })
    })

    const confirm = await screen.findByTestId('local-codex-subscription-restart-confirm')
    await userEvent.click(confirm)

    await waitFor(() => {
      expect(invokeDesktopHostMock).toHaveBeenCalledWith('app.relaunch')
    })
  })

  test('rolls back the preference when the restart is cancelled', async () => {
    render(<ModelSettingsPage />)

    const toggle = await screen.findByTestId('local-codex-subscription-toggle')
    await userEvent.click(toggle)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        localCodexSubscriptionEnabled: false,
      })
    })

    // Cancel the restart dialog.
    const cancel = screen.getByRole('button', { name: '取消' })
    await userEvent.click(cancel)

    await waitFor(() => {
      expect(updateAppPreferencesMock).toHaveBeenCalledWith({
        localCodexSubscriptionEnabled: true,
      })
    })
  })

  test('hides the cloud connection pill when the subscription is off', async () => {
    render(
      <AppPreferencesContext.Provider
        value={{
          loaded: true,
          preferences: { ...defaultAppPreferences, localCodexSubscriptionEnabled: false },
        }}
      >
        <ModelSettingsPage />
      </AppPreferencesContext.Provider>
    )

    expect(await screen.findByTestId('local-codex-subscription-toggle')).toBeInTheDocument()
    const codexSection = screen.getByTestId('codex-auth-settings')
    expect(within(codexSection).queryByTestId('runtime-config-cloud-required')).toBeNull()
    expect(within(codexSection).queryByText('已连接云端')).toBeNull()
    expect(within(codexSection).queryByText('未连接云端')).toBeNull()
  })

  test('shows the cloud connection pill when the subscription is on', async () => {
    render(
      <AppPreferencesContext.Provider
        value={{
          loaded: true,
          preferences: { ...defaultAppPreferences, localCodexSubscriptionEnabled: true },
        }}
      >
        <ModelSettingsPage />
      </AppPreferencesContext.Provider>
    )

    expect(await screen.findByTestId('runtime-config-cloud-required')).toBeInTheDocument()
  })
})
