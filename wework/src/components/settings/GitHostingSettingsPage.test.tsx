import { defaultAppPreferences } from '@/desktop/appPreferences'
import { act, render, screen, waitFor } from '@testing-library/react'
import { notifyLocalConnectorAuthChanged } from '@/api/local/localConnectorAuthEvents'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import './../../../src/i18n'
import { DeviceGitSyncSection } from './DeviceGitSyncSection'
import { GitHostingSettingsPage } from './GitHostingSettingsPage'

const getGitHostingCliStatus = vi.hoisted(() => vi.fn())
const updateAppPreferences = vi.hoisted(() => vi.fn())
const copyTextToClipboard = vi.hoisted(() => vi.fn())
const openExternalUrl = vi.hoisted(() => vi.fn())
const getGitAccountSyncSummary = vi.hoisted(() => vi.fn())
const getAllDevices = vi.hoisted(() => vi.fn())
const syncGitAccounts = vi.hoisted(() => vi.fn())
const cloudConnection = vi.hoisted(() => ({
  isConnected: true,
  apiBaseUrl: 'https://cloud.example.com/api',
  backendUrl: 'https://backend.example.com',
  webUrl: 'https://cloud.example.com',
  token: 'cloud-token',
  refreshUser: vi.fn(),
}))

vi.mock('@/api/gitHostingCli', () => ({
  getGitHostingCliStatus,
}))

vi.mock('@/features/app-preferences/useAppPreferencesState', () => ({
  useAppPreferencesState: () => ({
    loaded: true,
    preferences: defaultAppPreferences,
  }),
}))

vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => cloudConnection,
}))

vi.mock('./settings-cloud-api', () => ({
  createSettingsDeviceApi: () => ({
    getGitAccountSyncSummary,
    getAllDevices,
    syncGitAccounts,
  }),
}))

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return { ...actual, updateAppPreferences }
})

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard }))
vi.mock('@/lib/external-links', () => ({ openExternalUrl }))

describe('GitHostingSettingsPage', () => {
  test('refreshes after local authentication changes and external CLI changes on focus', async () => {
    getGitHostingCliStatus.mockResolvedValue({
      installed: true,
      authenticated: true,
      detectionError: null,
    })
    render(<GitHostingSettingsPage />)
    await waitFor(() =>
      expect(screen.getByTestId('git-hosting-cli-github-status')).toHaveTextContent('已就绪')
    )
    getGitHostingCliStatus.mockClear()
    getGitHostingCliStatus.mockResolvedValue({
      installed: true,
      authenticated: false,
      detectionError: null,
    })
    act(() => notifyLocalConnectorAuthChanged())
    await waitFor(() =>
      expect(screen.getByTestId('git-hosting-cli-github-status')).toHaveTextContent('未登录')
    )
    expect(getGitHostingCliStatus.mock.calls.map(([provider]) => provider)).toContain('github')
    getGitHostingCliStatus.mockResolvedValue({
      installed: true,
      authenticated: true,
      detectionError: null,
    })
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() =>
      expect(screen.getByTestId('git-hosting-cli-github-status')).toHaveTextContent('已就绪')
    )
  })
  beforeEach(() => {
    cloudConnection.isConnected = true
    cloudConnection.apiBaseUrl = 'https://cloud.example.com/api'
    cloudConnection.webUrl = 'https://cloud.example.com'
    cloudConnection.token = 'cloud-token'
    getGitHostingCliStatus.mockReset()
    updateAppPreferences.mockReset()
    copyTextToClipboard.mockReset()
    openExternalUrl.mockReset()
    getGitAccountSyncSummary.mockReset()
    getAllDevices.mockReset()
    syncGitAccounts.mockReset()
    cloudConnection.refreshUser.mockReset()
    cloudConnection.refreshUser.mockResolvedValue(null)
    updateAppPreferences.mockImplementation(async patch => ({
      ...defaultAppPreferences,
      ...patch,
    }))
    copyTextToClipboard.mockResolvedValue(undefined)
    openExternalUrl.mockResolvedValue(true)
    getGitAccountSyncSummary.mockResolvedValue({
      accounts: [
        {
          id: 'git-1',
          domain: 'git.example.com',
          provider: 'gitlab',
          login: 'alice',
          email: 'alice@example.com',
          effective: true,
          duplicate_of: null,
        },
        {
          id: 'git-2',
          domain: 'git.example.com',
          provider: 'gitlab',
          login: 'alice-secondary',
          email: 'alice-secondary@example.com',
          effective: false,
          duplicate_of: 'git-1',
        },
      ],
      effective_count: 1,
      duplicate_count: 1,
    })
    getAllDevices.mockResolvedValue([
      {
        id: 1,
        device_id: 'remote-1',
        name: 'Remote One',
        status: 'online',
        is_default: false,
        device_type: 'remote',
        bind_shell: 'claudecode',
      },
      {
        id: 2,
        device_id: 'cloud-busy',
        name: 'Busy Cloud',
        status: 'busy',
        is_default: false,
        device_type: 'cloud',
        bind_shell: 'claudecode',
      },
      {
        id: 3,
        device_id: 'local-1',
        name: 'Local One',
        status: 'online',
        is_default: false,
        device_type: 'local',
        bind_shell: 'claudecode',
      },
    ])
    syncGitAccounts.mockResolvedValue({
      device_id: 'remote-1',
      status: 'synced_with_warnings',
      synced_domains: ['git.example.com'],
      removed_domains: [],
      duplicate_domains: ['git.example.com'],
      identity_warning_domains: [],
      cli: [
        {
          provider: 'glab',
          domain: 'git.example.com',
          status: 'not_installed',
          reason_code: 'cli_not_installed',
          detail: null,
        },
      ],
      warning_codes: [],
    })
    getGitHostingCliStatus.mockImplementation(async provider =>
      provider === 'github'
        ? {
            provider,
            tool: 'gh',
            installed: true,
            authenticated: false,
            executablePath: '/opt/homebrew/bin/gh',
            version: 'gh version 2.80.0',
            detectionError: null,
          }
        : {
            provider,
            tool: 'glab',
            installed: false,
            authenticated: false,
            executablePath: null,
            version: null,
            detectionError: null,
          }
    )
  })

  test('offers login and installation configuration actions', async () => {
    render(<GitHostingSettingsPage />)
    await screen.findByText('gh version 2.80.0')

    await userEvent.click(screen.getByTestId('git-hosting-cli-github-copy-login'))
    expect(copyTextToClipboard).toHaveBeenCalledWith('gh auth login')

    await userEvent.click(screen.getByTestId('git-hosting-cli-gitlab-install'))
    expect(openExternalUrl).toHaveBeenCalledWith('https://docs.gitlab.com/cli/')
  })

  test('does not offer remediation when CLI detection fails', async () => {
    getGitHostingCliStatus.mockImplementation(async provider => {
      if (provider === 'github') {
        throw new Error('executor unavailable')
      }
      return {
        provider,
        tool: 'glab',
        installed: true,
        authenticated: false,
        executablePath: '/usr/local/bin/glab',
        version: null,
        detectionError: 'timeout',
      }
    })

    render(<GitHostingSettingsPage />)

    await waitFor(() => {
      expect(screen.getByTestId('git-hosting-cli-github-status')).toHaveTextContent('检测失败')
      expect(screen.getByTestId('git-hosting-cli-gitlab-status')).toHaveTextContent('检测失败')
    })
    expect(screen.queryByTestId('git-hosting-cli-github-install')).not.toBeInTheDocument()
    expect(screen.queryByTestId('git-hosting-cli-gitlab-copy-login')).not.toBeInTheDocument()
  })

  test('syncs cloud Git accounts only to an explicitly selected eligible device', async () => {
    render(<DeviceGitSyncSection />)

    expect(await screen.findAllByText('gitlab · git.example.com')).toHaveLength(2)
    expect(screen.getByTestId('git-device-sync-duplicate-warning')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Remote One · remote' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Busy Cloud · cloud' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Local One · local' })).not.toBeInTheDocument()
    expect(screen.getByTestId('git-device-sync-submit')).toBeDisabled()

    await userEvent.selectOptions(screen.getByTestId('git-device-sync-select'), 'remote-1')
    await userEvent.click(screen.getByTestId('git-device-sync-submit'))

    await waitFor(() => expect(syncGitAccounts).toHaveBeenCalledWith('remote-1', false))
    expect(await screen.findByTestId('git-device-sync-result')).toHaveTextContent(
      'CLI 未安装，Git 凭据已写入；仓库访问仍需检查'
    )
  })

  test('shows CLI failure detail from the device sync result', async () => {
    syncGitAccounts.mockResolvedValue({
      device_id: 'remote-1',
      status: 'synced_with_warnings',
      synced_domains: ['git.example.com'],
      removed_domains: [],
      duplicate_domains: [],
      identity_warning_domains: [],
      cli: [
        {
          provider: 'glab',
          domain: 'git.example.com',
          status: 'failed',
          reason_code: 'cli_auth_failed',
          detail: 'exit=1 error validating token: unauthorized',
        },
      ],
      warning_codes: [],
    })
    render(<DeviceGitSyncSection />)

    await screen.findAllByText('gitlab · git.example.com')
    await userEvent.selectOptions(screen.getByTestId('git-device-sync-select'), 'remote-1')
    await userEvent.click(screen.getByTestId('git-device-sync-submit'))

    expect(await screen.findByTestId('git-device-sync-result')).toHaveTextContent(
      'CLI 登录失败，Git 凭据已写入；仓库访问仍需检查（exit=1 error validating token: unauthorized）'
    )
  })

  test('requires confirmation before clearing managed credentials', async () => {
    getGitAccountSyncSummary.mockResolvedValue({
      accounts: [],
      effective_count: 0,
      duplicate_count: 0,
    })
    syncGitAccounts.mockResolvedValue({
      device_id: 'remote-1',
      status: 'synced',
      synced_domains: [],
      removed_domains: ['git.example.com'],
      duplicate_domains: [],
      identity_warning_domains: [],
      cli: [],
      warning_codes: [],
    })
    render(<DeviceGitSyncSection />)

    await screen.findByText('云端尚未配置 Git 账户。')
    await userEvent.selectOptions(screen.getByTestId('git-device-sync-select'), 'remote-1')
    expect(screen.getByTestId('git-device-sync-submit')).toBeDisabled()
    await userEvent.click(screen.getByTestId('git-device-sync-clear'))

    expect(screen.getByTestId('git-device-sync-clear-dialog')).toBeInTheDocument()
    expect(syncGitAccounts).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('git-device-sync-clear-confirm'))
    await waitFor(() => expect(syncGitAccounts).toHaveBeenCalledWith('remote-1', true))
  })

  test('guides missing accounts to the actual cloud Git settings without clearing credentials', async () => {
    getGitAccountSyncSummary.mockResolvedValue({
      accounts: [],
      effective_count: 0,
      duplicate_count: 0,
    })
    render(<DeviceGitSyncSection />)
    await screen.findByText('云端尚未配置 Git 账户。')
    await userEvent.click(screen.getByTestId('git-device-sync-configure'))
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://cloud.example.com/settings?tab=integrations#git-accounts',
      { source: 'device-git-settings' }
    )
    expect(syncGitAccounts).not.toHaveBeenCalled()
  })

  test('waits for Web metadata without sending users to Backend or clearing credentials', async () => {
    cloudConnection.webUrl = ''
    const { rerender } = render(<DeviceGitSyncSection />)
    await screen.findByTestId('git-device-sync-accounts')
    expect(screen.queryByTestId('git-device-sync-configure')).not.toBeInTheDocument()
    expect(openExternalUrl).not.toHaveBeenCalled()
    expect(syncGitAccounts).not.toHaveBeenCalled()
    cloudConnection.webUrl = 'https://cloud.example.com'
    rerender(<DeviceGitSyncSection />)
    await userEvent.click(screen.getByTestId('git-device-sync-configure'))
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://cloud.example.com/settings?tab=integrations#git-accounts',
      { source: 'device-git-settings' }
    )
    expect(syncGitAccounts).not.toHaveBeenCalled()
  })

  test('shows managed cleanup and terminal restart guidance', async () => {
    syncGitAccounts.mockResolvedValue({
      device_id: 'remote-1',
      status: 'synced_with_warnings',
      synced_domains: ['git.example.com'],
      removed_domains: [],
      duplicate_domains: [],
      identity_warning_domains: [],
      cli: [
        {
          provider: 'glab',
          domain: 'git.example.com',
          status: 'configured',
          reason_code: null,
          detail: null,
        },
      ],
      warning_codes: ['stale_cleanup_failed'],
    })
    render(<DeviceGitSyncSection />)

    await screen.findAllByText('gitlab · git.example.com')
    await userEvent.selectOptions(screen.getByTestId('git-device-sync-select'), 'remote-1')
    await userEvent.click(screen.getByTestId('git-device-sync-submit'))

    expect(await screen.findByTestId('git-device-sync-managed-warning')).toBeInTheDocument()
    expect(screen.getByTestId('git-device-sync-terminal-hint')).toBeInTheDocument()
  })

  test('shows disconnected and load failure states without selecting a device', async () => {
    cloudConnection.isConnected = false
    const { unmount } = render(<DeviceGitSyncSection />)

    expect(await screen.findByTestId('git-device-sync-disconnected')).toBeInTheDocument()
    expect(getGitAccountSyncSummary).not.toHaveBeenCalled()
    unmount()

    cloudConnection.isConnected = true
    getGitAccountSyncSummary.mockRejectedValue(new Error('summary unavailable'))
    render(<DeviceGitSyncSection />)

    expect(await screen.findByTestId('git-device-sync-error')).toHaveTextContent(
      'summary unavailable'
    )
    expect(screen.queryByTestId('git-device-sync-accounts')).not.toBeInTheDocument()
    expect(screen.queryByTestId('git-device-sync-submit')).not.toBeInTheDocument()
  })
})
