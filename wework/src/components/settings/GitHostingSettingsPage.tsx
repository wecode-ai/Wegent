import {
  AlertTriangle,
  Check,
  Cloud,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getGitHostingCliStatus,
  type GitHostingCliProvider,
  type GitHostingCliStatus,
} from '@/api/gitHostingCli'
import { ApiError } from '@/api/http'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { openExternalUrl } from '@/lib/external-links'
import { updateAppPreferences } from '@/desktop/appPreferences'
import type { DeviceInfo } from '@/types/devices'
import type { DeviceGitAccountSyncResult, GitAccountSyncSummary } from '@/types/gitCredentials'
import { createSettingsDeviceApi } from './settings-cloud-api'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

const PROVIDERS: GitHostingCliProvider[] = ['github', 'gitlab']
const PROVIDER_CONFIG = {
  github: {
    tool: 'gh',
    installUrl: 'https://cli.github.com/',
    loginCommand: 'gh auth login',
  },
  gitlab: {
    tool: 'glab',
    installUrl: 'https://docs.gitlab.com/cli/',
    loginCommand: 'glab auth login',
  },
} as const

function statusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  status: GitHostingCliStatus | undefined,
  loading: boolean
) {
  if (loading) return t('workbench.git_hosting_cli_detecting', '检测中…')
  if (!status) return t('workbench.git_hosting_cli_detection_failed', '检测失败')
  if (status.detectionError) {
    return t('workbench.git_hosting_cli_detection_failed', '检测失败')
  }
  if (!status.installed) return t('workbench.git_hosting_cli_not_installed', '未安装')
  if (!status.authenticated) return t('workbench.git_hosting_cli_not_authenticated', '未登录')
  return t('workbench.git_hosting_cli_ready', '已就绪')
}

function syncLoadErrorMessage(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return t(
      'workbench.git_device_sync_login_expired',
      'Wegent 云端登录已失效，请在“云端连接”中重新连接后重试。'
    )
  }
  if (error instanceof ApiError && error.status === 404) {
    return t(
      'workbench.git_device_sync_backend_unsupported',
      '当前 Wegent Backend 不支持设备 Git 配置同步，请更新服务后重试。'
    )
  }
  return error instanceof Error && error.message
    ? error.message
    : t('workbench.git_device_sync_load_failed', '读取设备 Git 配置失败')
}

export function GitHostingSettingsPage() {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const refreshCloudUser = cloudConnection.refreshUser
  const syncConnection = useMemo(
    () => ({
      isConnected: cloudConnection.isConnected,
      apiBaseUrl: cloudConnection.apiBaseUrl,
      token: cloudConnection.token,
    }),
    [cloudConnection.apiBaseUrl, cloudConnection.isConnected, cloudConnection.token]
  )
  const preferencesState = useAppPreferencesState()
  const enabled = preferencesState?.preferences.changeRequestStatusEnabled ?? true
  const [statuses, setStatuses] = useState<
    Partial<Record<GitHostingCliProvider, GitHostingCliStatus>>
  >({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedProvider, setCopiedProvider] = useState<GitHostingCliProvider | null>(null)
  const [syncSummary, setSyncSummary] = useState<GitAccountSyncSummary | null>(null)
  const [syncDevices, setSyncDevices] = useState<DeviceInfo[]>([])
  const [syncLoading, setSyncLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<DeviceGitAccountSyncResult | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const detect = useCallback(async () => {
    setLoading(true)
    setError(null)
    const results = await Promise.allSettled(PROVIDERS.map(getGitHostingCliStatus))
    const nextStatuses: Partial<Record<GitHostingCliProvider, GitHostingCliStatus>> = {}
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        nextStatuses[PROVIDERS[index]] = result.value
      }
    })
    setStatuses(nextStatuses)
    if (results.some(result => result.status === 'rejected')) {
      setError(t('workbench.git_hosting_cli_detection_failed', 'CLI 状态检测失败'))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    const timeout = window.setTimeout(() => void detect(), 0)
    return () => window.clearTimeout(timeout)
  }, [detect])

  const loadSyncConfiguration = useCallback(async () => {
    setSyncError(null)
    setSyncResult(null)
    if (!syncConnection.isConnected || !syncConnection.apiBaseUrl || !syncConnection.token) {
      setSyncSummary(null)
      setSyncDevices([])
      setSelectedDeviceId('')
      setSyncLoading(false)
      return
    }

    setSyncLoading(true)
    try {
      const api = createSettingsDeviceApi(syncConnection)
      const [summary, devices] = await Promise.all([
        api.getGitAccountSyncSummary(),
        api.getAllDevices(),
      ])
      const eligibleDevices = devices.filter(
        device =>
          device.status === 'online' &&
          (device.device_type === 'cloud' || device.device_type === 'remote') &&
          device.bind_shell === 'claudecode'
      )
      setSyncSummary(summary)
      setSyncDevices(eligibleDevices)
      setSelectedDeviceId(current =>
        eligibleDevices.some(device => device.device_id === current) ? current : ''
      )
    } catch (loadError) {
      console.error('Failed to load device Git sync configuration:', loadError)
      setSyncSummary(null)
      setSyncDevices([])
      setSelectedDeviceId('')
      setSyncError(syncLoadErrorMessage(t, loadError))
      if (loadError instanceof ApiError && loadError.status === 401) {
        void refreshCloudUser()
      }
    } finally {
      setSyncLoading(false)
    }
  }, [refreshCloudUser, syncConnection, t])

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadSyncConfiguration(), 0)
    return () => window.clearTimeout(timeout)
  }, [loadSyncConfiguration])

  const performSync = async (allowEmpty: boolean) => {
    if (!selectedDeviceId) return
    setConfirmClear(false)
    setSyncing(true)
    setSyncError(null)
    setSyncResult(null)
    try {
      const result = await createSettingsDeviceApi(syncConnection).syncGitAccounts(
        selectedDeviceId,
        allowEmpty
      )
      setSyncResult(result)
    } catch (syncFailure) {
      console.error('Failed to sync Git credentials to device:', syncFailure)
      setSyncError(
        syncFailure instanceof Error && syncFailure.message
          ? syncFailure.message
          : t('workbench.git_device_sync_failed', '同步设备 Git 配置失败')
      )
    } finally {
      setSyncing(false)
    }
  }

  const requestSync = () => {
    if ((syncSummary?.effective_count ?? 0) === 0) {
      setConfirmClear(true)
      return
    }
    void performSync(false)
  }

  const updateEnabled = async (nextEnabled: boolean) => {
    setSaving(true)
    setError(null)
    try {
      await updateAppPreferences({ changeRequestStatusEnabled: nextEnabled })
    } catch (updateError) {
      console.error('Failed to save change request status preference:', updateError)
      setError(t('workbench.git_hosting_settings_save_failed', '代码托管设置保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const copyLoginCommand = async (provider: GitHostingCliProvider) => {
    await copyTextToClipboard(PROVIDER_CONFIG[provider].loginCommand)
    setCopiedProvider(provider)
    window.setTimeout(
      () => setCopiedProvider(current => (current === provider ? null : current)),
      1500
    )
  }

  return (
    <SettingsPage data-testid="git-hosting-settings-page">
      <SettingsPageHeader
        title={t('workbench.git_hosting_settings_title', '代码托管')}
        description={t(
          'workbench.git_hosting_settings_description',
          '检测当前设备上的 GitHub CLI 或 GitLab CLI，并将云端保存的 Git 账户安全同步到你明确选择的设备。'
        )}
        actions={
          <button
            type="button"
            data-testid="git-hosting-cli-refresh"
            onClick={() => void detect()}
            disabled={loading}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t('workbench.git_hosting_cli_refresh', '重新检测')}
          </button>
        }
      />

      <SettingsGroup>
        <SettingsRow
          data-testid="change-request-status-setting"
          label={t('workbench.git_hosting_status_switch', '显示 PR / MR 状态')}
          description={t(
            'workbench.git_hosting_status_switch_description',
            '开启后，Wework 会通过当前设备上的 gh 或 glab 查询当前分支状态。关闭后不会执行这些查询。'
          )}
          control={
            <SettingsSwitch
              data-testid="change-request-status-switch"
              checked={enabled}
              disabled={saving}
              onCheckedChange={nextEnabled => void updateEnabled(nextEnabled)}
            />
          }
        />
      </SettingsGroup>

      <div className="mt-6 space-y-3">
        {PROVIDERS.map(provider => {
          const config = PROVIDER_CONFIG[provider]
          const status = statuses[provider]
          const ready = !status?.detectionError && status?.installed && status.authenticated
          return (
            <section
              key={provider}
              data-testid={`git-hosting-cli-${provider}`}
              className="rounded-2xl border border-border bg-surface/70 px-4 py-4"
            >
              <div className="flex items-start gap-3">
                <GitBranch className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-medium text-text-primary">
                      {provider === 'github' ? 'GitHub CLI' : 'GitLab CLI'}
                    </h2>
                    <span
                      data-testid={`git-hosting-cli-${provider}-status`}
                      className={`text-xs ${ready ? 'text-green-500' : 'text-text-muted'}`}
                    >
                      {statusLabel(t, status, loading)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-4 text-text-secondary">
                    {status?.version ||
                      t('workbench.git_hosting_cli_tool_hint', {
                        tool: config.tool,
                        defaultValue: `命令：${config.tool}`,
                      })}
                  </p>
                  {status?.executablePath ? (
                    <p className="mt-1 truncate text-code text-text-muted">
                      {status.executablePath}
                    </p>
                  ) : null}
                </div>
              </div>

              {!loading && status && !status.detectionError && !ready ? (
                <div className="mt-4 flex flex-wrap gap-2 pl-8">
                  {!status.installed ? (
                    <button
                      type="button"
                      data-testid={`git-hosting-cli-${provider}-install`}
                      onClick={() => void openExternalUrl(config.installUrl)}
                      className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {t('workbench.git_hosting_cli_install', '安装指引')}
                    </button>
                  ) : null}
                  {status.installed && !status.authenticated ? (
                    <button
                      type="button"
                      data-testid={`git-hosting-cli-${provider}-copy-login`}
                      onClick={() => void copyLoginCommand(provider)}
                      className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover"
                    >
                      {copiedProvider === provider ? (
                        <Check className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                      {copiedProvider === provider
                        ? t('workbench.git_hosting_cli_login_copied', '已复制')
                        : t('workbench.git_hosting_cli_copy_login', {
                            command: config.loginCommand,
                            defaultValue: `复制 ${config.loginCommand}`,
                          })}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </section>
          )
        })}
      </div>

      <section
        data-testid="git-device-sync-section"
        className="mt-8 rounded-2xl border border-border bg-surface/70 px-4 py-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" />
            <div>
              <h2 className="text-sm font-medium text-text-primary">
                {t('workbench.git_device_sync_title', '设备 Git 配置')}
              </h2>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {t(
                  'workbench.git_device_sync_description',
                  '把云端 Git 账户同步到一台在线的 ClaudeCode 云端或远程设备。只有点击同步后才会写入设备。'
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="git-device-sync-refresh"
            onClick={() => void loadSyncConfiguration()}
            disabled={syncLoading || syncing}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover disabled:opacity-50"
          >
            {syncLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {t('workbench.git_device_sync_refresh', '刷新')}
          </button>
        </div>

        {!cloudConnection.isConnected ? (
          <p data-testid="git-device-sync-disconnected" className="mt-4 text-xs text-text-muted">
            {t('workbench.git_device_sync_cloud_required', '连接 Wegent 云端后可同步 Git 配置。')}
          </p>
        ) : syncLoading ? (
          <div
            data-testid="git-device-sync-loading"
            className="mt-4 flex items-center gap-2 text-xs text-text-muted"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('workbench.git_device_sync_loading', '正在读取 Git 账户和设备…')}
          </div>
        ) : !syncSummary ? (
          syncError ? (
            <p data-testid="git-device-sync-error" className="mt-4 text-xs text-red-500">
              {syncError}
            </p>
          ) : null
        ) : (
          <div className="mt-4 space-y-4">
            <div data-testid="git-device-sync-accounts">
              <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
                <ShieldCheck className="h-4 w-4 text-green-500" />
                {t('workbench.git_device_sync_account_count', {
                  count: syncSummary?.effective_count ?? 0,
                  defaultValue: `将同步 ${syncSummary?.effective_count ?? 0} 个域`,
                })}
              </div>
              {syncSummary?.accounts.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {syncSummary.accounts.map((account, index) => (
                    <span
                      key={account.id ?? `${account.domain}-${index}`}
                      className={`rounded-full bg-muted px-2 py-1 text-xs ${
                        account.effective ? 'text-text-secondary' : 'text-text-muted line-through'
                      }`}
                    >
                      {account.provider} · {account.domain}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-text-muted">
                  {t('workbench.git_device_sync_no_accounts', '云端尚未配置 Git 账户。')}
                </p>
              )}
              {(syncSummary?.duplicate_count ?? 0) > 0 ? (
                <p
                  data-testid="git-device-sync-duplicate-warning"
                  className="mt-2 flex items-center gap-1.5 text-xs text-yellow-500"
                >
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t(
                    'workbench.git_device_sync_duplicate_warning',
                    '同一域只同步配置顺序中的第一个账户。'
                  )}
                </p>
              ) : null}
            </div>

            <label className="block text-xs font-medium text-text-primary">
              {t('workbench.git_device_sync_target', '目标设备')}
              <select
                data-testid="git-device-sync-select"
                value={selectedDeviceId}
                onChange={event => setSelectedDeviceId(event.target.value)}
                disabled={syncing || syncDevices.length === 0}
                className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary disabled:opacity-50"
              >
                <option value="">
                  {syncDevices.length
                    ? t('workbench.git_device_sync_select_placeholder', '请选择设备')
                    : t('workbench.git_device_sync_no_devices', '没有可同步的在线设备')}
                </option>
                {syncDevices.map(device => (
                  <option key={device.device_id} value={device.device_id}>
                    {device.name} · {device.device_type}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="git-device-sync-submit"
                onClick={requestSync}
                disabled={!selectedDeviceId || syncing}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {(syncSummary?.effective_count ?? 0) > 0
                  ? t('workbench.git_device_sync_submit', '同步 Git 配置')
                  : t('workbench.git_device_sync_clear', '清理 Wegent Git 配置')}
              </button>
              <span className="text-xs text-text-muted">
                {t(
                  'workbench.git_device_sync_security_hint',
                  '访问令牌不会返回到 Wework；目标设备会以私有文件保存凭据。'
                )}
              </span>
            </div>

            {syncResult ? (
              <div
                data-testid="git-device-sync-result"
                className={`rounded-lg px-3 py-2 text-xs ${
                  syncResult.status === 'synced'
                    ? 'bg-green-500/10 text-green-500'
                    : 'bg-yellow-500/10 text-yellow-500'
                }`}
              >
                <p>
                  {t('workbench.git_device_sync_success', {
                    count: syncResult.synced_domains.length,
                    defaultValue: `已同步 ${syncResult.synced_domains.length} 个域。`,
                  })}
                </p>
                {syncResult.removed_domains.length ? (
                  <p className="mt-1">
                    {t('workbench.git_device_sync_removed', {
                      domains: syncResult.removed_domains.join(', '),
                      defaultValue: `已移除：${syncResult.removed_domains.join(', ')}`,
                    })}
                  </p>
                ) : null}
                {syncResult.cli
                  .filter(item => item.status !== 'configured')
                  .map(item => (
                    <p key={`${item.provider}-${item.domain}`} className="mt-1">
                      {item.provider} · {item.domain}:{' '}
                      {item.status === 'not_installed'
                        ? t('workbench.git_device_sync_cli_missing', 'CLI 未安装，Git 认证已生效')
                        : t('workbench.git_device_sync_cli_failed', 'CLI 登录失败，Git 认证已生效')}
                    </p>
                  ))}
                {syncResult.identity_warning_domains.length ? (
                  <p className="mt-1">
                    {t('workbench.git_device_sync_identity_warning', {
                      domains: syncResult.identity_warning_domains.join(', '),
                      defaultValue: `以下域缺少完整提交身份：${syncResult.identity_warning_domains.join(', ')}`,
                    })}
                  </p>
                ) : null}
                {syncResult.warning_codes.length ? (
                  <p data-testid="git-device-sync-managed-warning" className="mt-1">
                    {t(
                      'workbench.git_device_sync_managed_warning',
                      '部分旧的 Wegent 托管文件未能立即清理，可安全重试同步。'
                    )}
                  </p>
                ) : null}
                {syncResult.cli.some(item => item.status === 'configured') ? (
                  <p data-testid="git-device-sync-terminal-hint" className="mt-1">
                    {t(
                      'workbench.git_device_sync_terminal_hint',
                      'CLI 配置已更新，请打开新终端后使用。'
                    )}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {syncError && syncSummary ? (
          <p data-testid="git-device-sync-error" className="mt-4 text-xs text-red-500">
            {syncError}
          </p>
        ) : null}
      </section>

      {error ? (
        <p data-testid="git-hosting-settings-error" className="mt-4 text-xs text-red-500">
          {error}
        </p>
      ) : null}

      {confirmClear ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-device-sync-clear-title"
          data-testid="git-device-sync-clear-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-xl">
            <h2 id="git-device-sync-clear-title" className="text-sm font-medium text-text-primary">
              {t('workbench.git_device_sync_clear_confirm_title', '清理设备 Git 配置？')}
            </h2>
            <p className="mt-2 text-xs leading-5 text-text-secondary">
              {t(
                'workbench.git_device_sync_clear_confirm_description',
                '当前没有可同步账户。继续后只会删除所选设备上由 Wegent 管理的 Git 和 CLI 配置。'
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="git-device-sync-clear-cancel"
                onClick={() => setConfirmClear(false)}
                className="h-8 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="git-device-sync-clear-confirm"
                onClick={() => void performSync(true)}
                className="h-8 rounded-lg bg-red-500 px-3 text-sm text-white hover:bg-red-600"
              >
                {t('workbench.git_device_sync_clear_confirm', '确认清理')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsPage>
  )
}
