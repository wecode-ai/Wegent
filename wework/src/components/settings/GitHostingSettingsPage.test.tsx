import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/api/http'
import { defaultAppPreferences } from '@/desktop/appPreferences'
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
  beforeEach(() => {
    cloudConnection.isConnected = true
    cloudConnection.apiBaseUrl = 'https://cloud.example.com/api'
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

  test('detects both CLIs and saves the PR/MR status switch', async () => {
    render(<GitHostingSettingsPage />)

    await waitFor(() => {
      expect(screen.getByTestId('git-hosting-cli-github-status')).toHaveTextContent('未登录')
      expect(screen.getByTestId('git-hosting-cli-gitlab-status')).toHaveTextContent('未安装')
    })

    await userEvent.click(screen.getByTestId('change-request-status-switch'))
    expect(updateAppPreferences).toHaveBeenCalledWith({ changeRequestStatusEnabled: false })
    expect(screen.queryByTestId('git-device-sync-section')).not.toBeInTheDocument()
  })

  test('offers login and installation configuration actions', async () => {
    render(<GitHostingSettingsPage />)
    await screen.findByText('gh version 2.80.0')

    await userEvent.click(screen.getByTestId('git-hosting-cli-github-copy-login'))
    expect(copyTextToClipboard).toHaveBeenCalledWith('gh auth login')

    await userEvent.click(screen.getByTestId('git-hosting-cli-gitlab-install'))
    expect(openExternalUrl).toHaveBeenCalledWith('https://docs.gitlab.com/cli/')
  })

  test('rechecks CLI state on demand', async () => {
    render(<GitHostingSettingsPage />)

    await waitFor(() => expect(getGitHostingCliStatus).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByTestId('git-hosting-cli-refresh'))
    await waitFor(() => expect(getGitHostingCliStatus).toHaveBeenCalledTimes(4))
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
      'CLI 未安装，Git 认证已生效'
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
    await userEvent.click(screen.getByTestId('git-device-sync-submit'))

    expect(screen.getByTestId('git-device-sync-clear-dialog')).toBeInTheDocument()
    expect(syncGitAccounts).not.toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('git-device-sync-clear-confirm'))
    await waitFor(() => expect(syncGitAccounts).toHaveBeenCalledWith('remote-1', true))
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

  test('marks an expired cloud session without rendering missing accounts', async () => {
    getGitAccountSyncSummary.mockRejectedValue(new ApiError('Could not validate credentials', 401))

    render(<DeviceGitSyncSection />)

    expect(await screen.findByTestId('git-device-sync-error')).toHaveTextContent(
      'Wegent 云端登录已失效'
    )
    expect(cloudConnection.refreshUser).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('云端尚未配置 Git 账户。')).not.toBeInTheDocument()
  })

  test('explains when the connected Backend does not support Git sync', async () => {
    getGitAccountSyncSummary.mockRejectedValue(new ApiError('Not Found', 404))

    render(<DeviceGitSyncSection />)

    expect(await screen.findByTestId('git-device-sync-error')).toHaveTextContent(
      '当前 Wegent Backend 不支持设备 Git 配置同步'
    )
    expect(screen.queryByText('云端尚未配置 Git 账户。')).not.toBeInTheDocument()
  })
})
