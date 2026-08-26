import { AlertTriangle, Cloud, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/devices'
import type { DeviceGitAccountSyncResult, GitAccountSyncSummary } from '@/types/gitCredentials'
import { createSettingsDeviceApi } from './settings-cloud-api'

interface DeviceGitSyncSectionProps {
  devices?: DeviceInfo[]
  devicesLoading?: boolean
  onRefreshDevices?: () => Promise<unknown>
}

function httpErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function syncLoadErrorMessage(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  const status = httpErrorStatus(error)
  if (status === 401) {
    return t(
      'workbench.git_device_sync_login_expired',
      'Wegent 云端登录已失效，请在“云端连接”中重新连接后重试。'
    )
  }
  if (status === 404) {
    return t(
      'workbench.git_device_sync_backend_unsupported',
      '当前 Wegent Backend 不支持设备 Git 配置同步，请更新服务后重试。'
    )
  }
  return error instanceof Error && error.message
    ? error.message
    : t('workbench.git_device_sync_load_failed', '读取设备 Git 配置失败')
}

export function DeviceGitSyncSection({
  devices,
  devicesLoading = false,
  onRefreshDevices,
}: DeviceGitSyncSectionProps) {
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
  const [uncontrolledDevices, setUncontrolledDevices] = useState<DeviceInfo[]>([])
  const [syncSummary, setSyncSummary] = useState<GitAccountSyncSummary | null>(null)
  const [syncLoading, setSyncLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<DeviceGitAccountSyncResult | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const usesProvidedDevices = devices !== undefined
  const activeDevices = devices ?? uncontrolledDevices
  const eligibleDevices = useMemo(
    () =>
      activeDevices.filter(
        device =>
          device.status === 'online' &&
          (device.device_type === 'cloud' || device.device_type === 'remote') &&
          device.bind_shell === 'claudecode'
      ),
    [activeDevices]
  )
  const activeSelectedDeviceId = eligibleDevices.some(
    device => device.device_id === selectedDeviceId
  )
    ? selectedDeviceId
    : ''
  const loading = syncLoading || devicesLoading

  const loadSyncConfiguration = useCallback(
    async (refreshDevices: boolean) => {
      setSyncError(null)
      setSyncResult(null)
      if (!syncConnection.isConnected || !syncConnection.apiBaseUrl || !syncConnection.token) {
        setSyncSummary(null)
        setUncontrolledDevices([])
        setSelectedDeviceId('')
        setSyncLoading(false)
        return
      }

      setSyncLoading(true)
      try {
        const api = createSettingsDeviceApi(syncConnection)
        const summaryPromise = api.getGitAccountSyncSummary()
        const devicesPromise = refreshDevices
          ? usesProvidedDevices
            ? onRefreshDevices?.()
            : api.getAllDevices().then(nextDevices => setUncontrolledDevices(nextDevices))
          : undefined
        const [summary] = await Promise.all([summaryPromise, devicesPromise])
        setSyncSummary(summary)
      } catch (loadError) {
        console.error('Failed to load device Git sync configuration:', loadError)
        setSyncSummary(null)
        if (!usesProvidedDevices) setUncontrolledDevices([])
        setSelectedDeviceId('')
        setSyncError(syncLoadErrorMessage(t, loadError))
        if (httpErrorStatus(loadError) === 401) {
          void refreshCloudUser()
        }
      } finally {
        setSyncLoading(false)
      }
    },
    [onRefreshDevices, refreshCloudUser, syncConnection, t, usesProvidedDevices]
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadSyncConfiguration(!usesProvidedDevices), 0)
    return () => window.clearTimeout(timeout)
  }, [loadSyncConfiguration, usesProvidedDevices])

  const performSync = async (allowEmpty: boolean) => {
    if (!activeSelectedDeviceId) return
    setConfirmClear(false)
    setSyncing(true)
    setSyncError(null)
    setSyncResult(null)
    try {
      const result = await createSettingsDeviceApi(syncConnection).syncGitAccounts(
        activeSelectedDeviceId,
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

  return (
    <>
      <section
        data-testid="git-device-sync-section"
        className="rounded-2xl border border-border bg-surface/70 px-4 py-4"
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
            onClick={() => void loadSyncConfiguration(true)}
            disabled={loading || syncing}
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-muted px-3 text-sm text-text-primary hover:bg-hover disabled:opacity-50"
          >
            {loading ? (
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
        ) : loading ? (
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
                  count: syncSummary.effective_count,
                  defaultValue: `将同步 ${syncSummary.effective_count} 个域`,
                })}
              </div>
              {syncSummary.accounts.length ? (
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
              {syncSummary.duplicate_count > 0 ? (
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
                value={activeSelectedDeviceId}
                onChange={event => setSelectedDeviceId(event.target.value)}
                disabled={syncing || eligibleDevices.length === 0}
                className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-primary disabled:opacity-50"
              >
                <option value="">
                  {eligibleDevices.length
                    ? t('workbench.git_device_sync_select_placeholder', '请选择设备')
                    : t('workbench.git_device_sync_no_devices', '没有可同步的在线设备')}
                </option>
                {eligibleDevices.map(device => (
                  <option key={device.device_id} value={device.device_id}>
                    {device.name || device.device_id} · {device.device_type}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="git-device-sync-submit"
                onClick={requestSync}
                disabled={!activeSelectedDeviceId || syncing}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {syncSummary.effective_count > 0
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
    </>
  )
}
