import { IconButton } from '@wegent/collaboration/controls/IconButton'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Switch } from '@wegent/collaboration/controls/Switch'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { AlertCircle, ChevronDown, Loader2, RefreshCw, ShieldCheck, Upload } from 'lucide-react'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { CloudModelsSection, DisconnectedCloudModelsSection } from './CloudModelsSection'
import { CodexOfficialModelsSection } from './CodexOfficialModelsSection'
import { LocalCodexModelRow } from './LocalCodexModelRow'
import { LocalCodexTransportSettings } from './LocalCodexTransportSettings'
import { ProviderSettingsSection } from './ProviderSettingsSection'

import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { listLocalCodexAccounts, type LocalCodexAccounts } from '@/api/local/codexAuth'
import { getLocalCodexOfficialModels } from '@/api/local/codexOfficialModels'
import { getLocalCodexAuthStatus, type LocalRuntimeAuthStatus } from '@/api/local/runtimeAuthStatus'
import { createModelApi } from '@/api/models'
import type { UserRuntime, UserRuntimeConfig } from '@/api/users'
import { createUserApi } from '@/api/users'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type { CodexOfficialModelList } from '@/features/model-settings/codexOfficialModels'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { createLocalCodexAccountSession } from './localCodexAccountSession'

import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { isClaudeCodeDevice } from '@/lib/device-capabilities'

import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { useLocalCodexSubscriptionEnabled } from '@/features/app-preferences/useLocalCodexSubscriptionEnabled'

import type { DeviceInfo } from '@/types/devices'
import {
  SettingsGroup,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSwitch,
} from './settings-ui'

const EMPTY_DEVICES: DeviceInfo[] = []

interface CloudRuntimeSettingsConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
}

function createRuntimeSettingsApis(connection: CloudRuntimeSettingsConnection) {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }
  const client = createHttpClient({
    baseUrl: connection.apiBaseUrl,
    getToken: () => connection.token,
    redirectOnUnauthorized: false,
  })
  return {
    deviceApi: createDeviceApi(client),
    modelApi: createModelApi(client),
    userApi: createUserApi(client),
  }
}

function formatRuntimeDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortDigest(value?: string | null) {
  if (!value) return ''
  return value.length > 16 ? `${value.slice(0, 16)}...` : value
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function validateAuthJsonContent(content: string, invalidMessage: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(invalidMessage)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(invalidMessage)
  }
}

function DisconnectedCloudCodexSyncSection({
  status,
  accounts,
  loading,
  error,
  loginState,
  loginError,
  switchingAccountId,
  onLogin,
  onCancelLogin,
  onSwitchAccount,
  codexOfficialModels,
  codexOfficialLoading,
  codexOfficialError,
  onRefreshCodexOfficialModels,
  subscriptionEnabled,
}: {
  status: LocalRuntimeAuthStatus | null
  accounts: LocalCodexAccounts | null
  loading: boolean
  error: string | null
  loginState: 'idle' | 'starting' | 'waiting' | 'cancelling'
  loginError: string | null
  switchingAccountId: string | null
  onLogin: () => void
  onCancelLogin: () => void
  onSwitchAccount: (accountId: string) => void
  codexOfficialModels: CodexOfficialModelList | null
  codexOfficialLoading: boolean
  codexOfficialError: string | null
  onRefreshCodexOfficialModels: () => void | Promise<void>
  subscriptionEnabled: boolean
}) {
  const { t } = useTranslation('common')

  if (!subscriptionEnabled) {
    return null
  }

  return (
    <>
      <CodexSettingsGroup
        kind="models"
        description={t('modelCount', {
          ns: 'modelConnections',
          count: codexOfficialModels?.models.length ?? 0,
        })}
        title={t('modelsTitle', { ns: 'modelConnections' })}
      >
        <CodexOfficialModelsSection
          modelList={codexOfficialModels}
          loading={codexOfficialLoading}
          error={codexOfficialError}
          onRefresh={onRefreshCodexOfficialModels}
        />
      </CodexSettingsGroup>

      <CodexSettingsGroup kind="account" title={t('accountTitle', { ns: 'modelConnections' })}>
        <LocalCodexModelRow
          status={status}
          accounts={accounts}
          loading={loading}
          error={error}
          loginState={loginState}
          loginError={loginError}
          switchingAccountId={switchingAccountId}
          onLogin={onLogin}
          onCancelLogin={onCancelLogin}
          onSwitchAccount={onSwitchAccount}
        />
      </CodexSettingsGroup>
    </>
  )
}

function CodexSettingsGroup({
  title,
  children,
  kind,
  description,
}: {
  title: string
  children: React.ReactNode
  kind: 'models' | 'account'
  description?: string
}) {
  const { t } = useTranslation('modelConnections')
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <SettingsRow
        label={title}
        description={description}
        className="py-4"
        children={
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid={`codex-${kind}-details-toggle`}
            aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? t('collapse') : t(kind === 'models' ? 'viewModels' : 'manageAccount')}
            <ChevronDown
              className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </ControlButton>
        }
      />
      {expanded && <div className="space-y-3 px-4 pb-4">{children}</div>}
    </div>
  )
}

function LocalCodexSubscriptionToggle({
  enabled,
  loaded,
  onToggle,
}: {
  enabled: boolean
  loaded: boolean
  onToggle: (nextEnabled: boolean) => void
}) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="local-codex-subscription-toggle-row"
      className="flex items-center justify-between gap-4 px-4 py-4"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary">
          {t('workbench.local_codex_subscription_title', '本地 Codex 订阅')}
        </div>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          {t(
            'workbench.local_codex_subscription_description',
            '开启后才会加载本机 Codex 订阅账号及其模型；关闭后已链接的认证将不再自动恢复。'
          )}
        </p>
      </div>
      <SettingsSwitch
        data-testid="local-codex-subscription-toggle"
        checked={enabled}
        disabled={!loaded}
        onCheckedChange={onToggle}
        aria-label={t('workbench.local_codex_subscription_title', '本地 Codex 订阅')}
      />
    </div>
  )
}

function CodexAuthSettingsSection({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('modelConnections')
  return (
    <section data-testid="codex-auth-settings">
      <h2 className="mb-2 text-sm font-semibold text-text-primary">{t('subscriptionTitle')}</h2>
      <SettingsGroup data-testid="runtime-config-cloud-sync" className="rounded-xl !bg-background">
        {children}
      </SettingsGroup>
    </section>
  )
}

interface ModelSettingsPageProps {
  runtime?: UserRuntime
  onOpenCloudSettings?: () => void
}

export function ModelSettingsPage({
  runtime = 'codex',
  onOpenCloudSettings,
}: ModelSettingsPageProps) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedAuthSyncSource, setSelectedAuthSyncSource] = useState('local')
  const [updating, setUpdating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState(false)
  const { enabled: subscriptionEnabled, loaded: subscriptionLoaded } =
    useLocalCodexSubscriptionEnabled()
  const auth = useMemo(
    () =>
      createAsyncResource('local-codex-auth', async signal => {
        await Promise.resolve()
        signal.throwIfAborted()
        const [status, accounts] = await Promise.all([
          getLocalCodexAuthStatus(),
          listLocalCodexAccounts(),
        ])
        return { status, accounts }
      }),
    []
  )
  const authSnapshot = useSyncExternalStore(
    subscriptionEnabled ? auth.subscribe : subscribeIdleResource,
    auth.getSnapshot,
    getIdleResourceSnapshot
  )
  const localAuthStatus = authSnapshot.data?.status ?? null
  const localCodexAccounts = authSnapshot.data?.accounts ?? null
  const localAuthLoading =
    subscriptionEnabled && (authSnapshot.status === 'idle' || authSnapshot.status === 'loading')
  const localAuthError =
    authSnapshot.status === 'error'
      ? getErrorMessage(
          authSnapshot.error,
          t('workbench.local_codex_auth_load_failed', '读取本机 Codex auth 状态失败')
        )
      : null
  const [accountSession] = useState(createLocalCodexAccountSession)
  const account = useSyncExternalStore(
    accountSession.subscribe,
    accountSession.getSnapshot,
    accountSession.getServerSnapshot
  )
  const {
    loginState: localLoginState,
    loginError: localLoginError,
    switchingAccountId: switchingLocalAccountId,
  } = account
  const loadLocalAuthStatus = auth.reload
  const handleLocalCodexLogin = () => accountSession.login(localAuthStatus, loadLocalAuthStatus, t)
  const handleCancelLocalCodexLogin = () => accountSession.cancel(t)
  const handleSwitchLocalCodexAccount = (accountId: string) =>
    accountSession.switchAccount(accountId, data => auth.update(() => data), t)
  const official = useMemo(
    () =>
      createAsyncResource(
        'codex-official-models',
        async signal => {
          await Promise.resolve()
          signal.throwIfAborted()
          return getLocalCodexOfficialModels()
        },
        {
          success() {
            window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
          },
        }
      ),
    []
  )
  const officialSnapshot = useSyncExternalStore(
    subscriptionEnabled ? official.subscribe : subscribeIdleResource,
    official.getSnapshot,
    getIdleResourceSnapshot
  )
  const codexOfficialModels =
    officialSnapshot.status === 'error' ? null : (officialSnapshot.data ?? null)
  const codexOfficialLoading =
    subscriptionEnabled &&
    (officialSnapshot.status === 'idle' || officialSnapshot.status === 'loading')
  const codexOfficialError =
    officialSnapshot.status === 'error'
      ? getErrorMessage(officialSnapshot.error, t('workbench.codex_official_models_load_failed'))
      : null
  const loadCodexOfficialModels = official.reload
  const cloudQuery = useMemo(
    () =>
      createAsyncResource(runtime, async signal => {
        await Promise.resolve()
        signal.throwIfAborted()
        const { deviceApi, userApi } = createRuntimeSettingsApis(cloudConnection)
        const [config, devices] = await Promise.all([
          userApi.getRuntimeConfig(runtime),
          deviceApi.getAllDevices(),
        ])
        return { config, devices: devices.filter(isClaudeCodeDevice) }
      }),
    [cloudConnection, runtime]
  )
  const cloudSnapshot = useSyncExternalStore(
    cloudConnection.isConnected ? cloudQuery.subscribe : subscribeIdleResource,
    cloudQuery.getSnapshot,
    getIdleResourceSnapshot
  )
  const config = cloudSnapshot.data?.config ?? null
  const devices = cloudSnapshot.data?.devices ?? EMPTY_DEVICES
  const loading =
    cloudConnection.isConnected &&
    (cloudSnapshot.status === 'idle' ||
      (cloudSnapshot.status === 'loading' && !cloudSnapshot.settled))
  const refreshing = cloudSnapshot.status === 'loading' && cloudSnapshot.settled
  const loadRuntimeConfig = cloudQuery.reload
  const setConfig = (config: UserRuntimeConfig) =>
    cloudQuery.update(previous => ({ config, devices: previous?.devices ?? EMPTY_DEVICES }))
  const [actionError, setActionError] = useState<{
    owner: typeof cloudQuery
    message: string | null
  } | null>(null)
  const [actionNotice, setActionNotice] = useState<{
    owner: typeof cloudQuery
    message: string | null
  } | null>(null)
  const setError = (message: string | null) => setActionError({ owner: cloudQuery, message })
  const setNotice = (message: string | null) => setActionNotice({ owner: cloudQuery, message })
  const error =
    (actionError?.owner === cloudQuery ? actionError.message : null) ??
    (cloudSnapshot.status === 'error'
      ? getErrorMessage(
          cloudSnapshot.error,
          t('workbench.runtime_config_load_failed', '加载运行时配置失败')
        )
      : null)
  const notice = actionNotice?.owner === cloudQuery ? actionNotice.message : null
  const [restartDialogOpen, setRestartDialogOpen] = useState(false)
  const [restartPending, setRestartPending] = useState(false)
  const pendingSubscriptionEnabledRef = useRef<boolean | null>(null)

  const handleToggleLocalCodexSubscription = useCallback(async (nextEnabled: boolean) => {
    pendingSubscriptionEnabledRef.current = nextEnabled
    try {
      await updateAppPreferences({ localCodexSubscriptionEnabled: nextEnabled })
      setRestartDialogOpen(true)
    } catch {
      // The shared preference provider did not apply the change; nothing to revert.
      pendingSubscriptionEnabledRef.current = null
    }
  }, [])

  const handleCancelRestart = useCallback(async () => {
    const previous = pendingSubscriptionEnabledRef.current
    pendingSubscriptionEnabledRef.current = null
    setRestartDialogOpen(false)
    // Roll the preference back so the on-disk state matches the still-running
    // executor environment until the user actually restarts.
    if (previous !== null) {
      try {
        await updateAppPreferences({ localCodexSubscriptionEnabled: !previous })
      } catch {
        // Best-effort rollback; the restart dialog stays closed.
      }
    }
  }, [])

  const handleConfirmRestart = useCallback(async () => {
    pendingSubscriptionEnabledRef.current = null
    setRestartPending(true)
    try {
      await invokeDesktopHost<void>('app.relaunch')
    } catch {
      setRestartPending(false)
      setRestartDialogOpen(false)
    }
  }, [])

  const onlineDevices = useMemo(
    () => devices.filter(device => device.status === 'online' && isClaudeCodeDevice(device)),
    [devices]
  )
  const selectedImportDevice = useMemo(
    () =>
      selectedAuthSyncSource.startsWith('device:')
        ? (onlineDevices.find(device => `device:${device.device_id}` === selectedAuthSyncSource) ??
          null)
        : null,
    [onlineDevices, selectedAuthSyncSource]
  )
  const effectiveImportDeviceId = selectedImportDevice?.device_id ?? ''
  const selectedAuthSyncSourceIsLocal = selectedAuthSyncSource === 'local'
  const authSyncBusy = uploading || importing
  const canSyncAuthSource = selectedAuthSyncSourceIsLocal || Boolean(effectiveImportDeviceId)
  const authSourceActionLabel = selectedAuthSyncSourceIsLocal
    ? t('workbench.runtime_config_choose_local_auth_action', '选择并保存')
    : t('workbench.runtime_config_import_action', '读取并保存')

  const handleToggleUseUserConfig = async () => {
    if (!config || !config.configured || updating) return
    setUpdating(true)
    setError(null)
    setNotice(null)
    try {
      const { userApi } = createRuntimeSettingsApis(cloudConnection)
      const nextConfig = await userApi.updateRuntimeConfig(runtime, {
        use_user_config: !config.use_user_config,
      })
      setConfig(nextConfig)
    } catch (updateError) {
      setError(
        getErrorMessage(
          updateError,
          t('workbench.runtime_config_save_failed', '保存运行时配置失败')
        )
      )
    } finally {
      setUpdating(false)
    }
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    setUploading(true)
    setError(null)
    setNotice(null)
    try {
      const content = await file.text()
      validateAuthJsonContent(
        content,
        t('workbench.runtime_config_invalid_json', 'auth.json 必须是有效 JSON 对象')
      )
      const { userApi } = createRuntimeSettingsApis(cloudConnection)
      const nextConfig = await userApi.uploadRuntimeAuthJson(runtime, content)
      setConfig(nextConfig)
      setNotice(t('workbench.runtime_config_upload_success', 'auth.json 已保存'))
    } catch (uploadError) {
      setError(
        getErrorMessage(
          uploadError,
          t('workbench.runtime_config_upload_failed', '上传 auth.json 失败')
        )
      )
    } finally {
      setUploading(false)
    }
  }

  const handleImportFromDevice = async () => {
    if (!effectiveImportDeviceId || importing) return
    setImporting(true)
    setError(null)
    setNotice(null)
    try {
      const { userApi } = createRuntimeSettingsApis(cloudConnection)
      const nextConfig = await userApi.importRuntimeAuthJson(runtime, effectiveImportDeviceId)
      setConfig(nextConfig)
      setNotice(t('workbench.runtime_config_import_success', '已从设备导入 auth.json'))
    } catch (importError) {
      const message = getErrorMessage(
        importError,
        t('workbench.runtime_config_import_failed', '从设备导入失败')
      )
      setError(
        message.includes('runtime auth file does not exist')
          ? t(
              'workbench.runtime_config_source_auth_missing',
              '所选设备没有 Codex 认证，请选择本机或其他已配置设备。'
            )
          : message
      )
    } finally {
      setImporting(false)
    }
  }

  const handleSyncAuthSource = () => {
    if (!canSyncAuthSource || authSyncBusy) return
    if (selectedAuthSyncSourceIsLocal) {
      fileInputRef.current?.click()
      return
    }
    void handleImportFromDevice()
  }

  const statusLabel = config?.configured
    ? t('workbench.runtime_config_auth_saved', '认证已保存')
    : t('workbench.runtime_config_auth_not_saved', '认证未保存')
  const statusClassName = config?.configured
    ? 'bg-primary/10 text-primary'
    : 'bg-muted text-text-muted'
  const updatedAt = formatRuntimeDate(config?.auth_json_updated_at)

  const restartConfirmDialog = (
    <ConfirmDialog
      open={restartDialogOpen}
      title={t('workbench.local_codex_subscription_restart_title', '需要重启 Wework 生效')}
      description={t(
        'workbench.local_codex_subscription_restart_description',
        '本地 Codex 订阅的更改需要重启 Wework 后才会完全生效。请先保存尚未完成的工作。'
      )}
      cancelLabel={t('common.cancel', '取消')}
      confirmLabel={t('workbench.local_codex_subscription_restart_action', '重启')}
      confirmTestId="local-codex-subscription-restart-confirm"
      pending={restartPending}
      onClose={() => void handleCancelRestart()}
      onConfirm={() => void handleConfirmRestart()}
    />
  )

  if (!cloudConnection.isConnected) {
    return (
      <SettingsPage data-testid="model-settings-page">
        <SettingsPageHeader
          title={t('workbench.model_settings_title', '模型设置')}
          description={t('workbench.model_settings_subtitle', '管理模型接口和 Codex 设置。')}
        />

        <div>
          <CodexAuthSettingsSection>
            <LocalCodexSubscriptionToggle
              enabled={subscriptionEnabled}
              loaded={subscriptionLoaded}
              onToggle={checked => {
                void handleToggleLocalCodexSubscription(checked)
              }}
            />
            {subscriptionLoaded && subscriptionEnabled && <LocalCodexTransportSettings />}
            <DisconnectedCloudCodexSyncSection
              status={localAuthStatus}
              accounts={localCodexAccounts}
              loading={localAuthLoading}
              error={localAuthError}
              loginState={localLoginState}
              loginError={localLoginError}
              switchingAccountId={switchingLocalAccountId}
              onLogin={() => void handleLocalCodexLogin()}
              onCancelLogin={() => void handleCancelLocalCodexLogin()}
              onSwitchAccount={accountId => void handleSwitchLocalCodexAccount(accountId)}
              codexOfficialModels={codexOfficialModels}
              codexOfficialLoading={codexOfficialLoading}
              codexOfficialError={codexOfficialError}
              onRefreshCodexOfficialModels={loadCodexOfficialModels}
              subscriptionEnabled={subscriptionEnabled}
            />
          </CodexAuthSettingsSection>
        </div>
        <div className="mt-8">
          <ProviderSettingsSection />
        </div>
        <div className="mt-8">
          {cloudConnection.isConnected ? (
            <CloudModelsSection cloudConnection={cloudConnection} />
          ) : (
            <DisconnectedCloudModelsSection onOpenCloudSettings={onOpenCloudSettings} />
          )}
        </div>
        {restartConfirmDialog}
      </SettingsPage>
    )
  }

  return (
    <SettingsPage data-testid="model-settings-page">
      <SettingsPageHeader
        title={t('workbench.model_settings_title', '模型设置')}
        description={t('workbench.model_settings_subtitle', '管理模型接口和 Codex 设置。')}
        actions={
          <IconButton
            type="button"
            data-testid="runtime-config-refresh-button"
            onClick={() => void loadRuntimeConfig()}
            disabled={loading || refreshing}
            aria-label={t('workbench.runtime_config_refresh', '刷新')}
            title={t('workbench.runtime_config_refresh', '刷新')}
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </IconButton>
        }
      />

      <div>
        <CodexAuthSettingsSection>
          <LocalCodexSubscriptionToggle
            enabled={subscriptionEnabled}
            loaded={subscriptionLoaded}
            onToggle={checked => {
              void handleToggleLocalCodexSubscription(checked)
            }}
          />
          {subscriptionLoaded && subscriptionEnabled && <LocalCodexTransportSettings />}
          {loading ? (
            <div className="py-8 text-center text-sm text-text-secondary">
              {t('common.loading', '加载中...')}
            </div>
          ) : subscriptionEnabled ? (
            <>
              <CodexSettingsGroup
                kind="models"
                title={t('modelsTitle', { ns: 'modelConnections' })}
              >
                <CodexOfficialModelsSection
                  modelList={codexOfficialModels}
                  loading={codexOfficialLoading}
                  error={codexOfficialError}
                  onRefresh={() => void loadCodexOfficialModels()}
                />
              </CodexSettingsGroup>

              <CodexSettingsGroup
                kind="account"
                title={t('accountTitle', { ns: 'modelConnections' })}
              >
                <LocalCodexModelRow
                  status={localAuthStatus}
                  accounts={localCodexAccounts}
                  loading={localAuthLoading}
                  error={localAuthError}
                  loginState={localLoginState}
                  loginError={localLoginError}
                  switchingAccountId={switchingLocalAccountId}
                  onLogin={() => void handleLocalCodexLogin()}
                  onCancelLogin={() => void handleCancelLocalCodexLogin()}
                  onSwitchAccount={accountId => void handleSwitchLocalCodexAccount(accountId)}
                />

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-background px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-text-primary">
                        {t('workbench.runtime_config_auth_file_title', 'Codex 认证同步')}
                      </h3>
                      <span
                        data-testid="runtime-config-status"
                        className={`rounded-full px-2 py-0.5 text-xs ${statusClassName}`}
                      >
                        {statusLabel}
                      </span>
                      <Switch
                        data-testid="runtime-config-toggle"
                        checked={config?.use_user_config ?? false}
                        onCheckedChange={handleToggleUseUserConfig}
                        disabled={!config?.configured || updating}
                      />
                    </div>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">
                      {t(
                        'workbench.runtime_config_codex_description',
                        '从本机或在线设备保存一份认证；开启后自动同步到同一账号下缺少认证的设备。'
                      )}
                    </p>
                    {config?.configured && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                        {updatedAt && (
                          <span>
                            {t('workbench.runtime_config_updated_at', '更新时间')}: {updatedAt}
                          </span>
                        )}
                        {config.auth_json_sha256 && (
                          <span className="inline-flex items-center gap-1.5">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            SHA-256 {shortDigest(config.auth_json_sha256)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid min-w-[320px] gap-1.5">
                    <ControlInput
                      ref={fileInputRef}
                      type="file"
                      data-testid="runtime-config-file-input"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={event => void handleFileChange(event)}
                    />
                    <label
                      htmlFor="runtime-config-sync-source"
                      className="text-xs text-text-secondary"
                    >
                      {t('workbench.runtime_config_sync_source', '认证来源')}
                    </label>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <SelectRoot
                        value={normalizeSelectValue(selectedAuthSyncSource)}
                        onValueChange={selectedValue => {
                          if (selectedValue !== null)
                            return setSelectedAuthSyncSource(selectedValue)
                        }}
                        disabled={authSyncBusy}
                      >
                        <SelectTrigger
                          id="runtime-config-sync-source"
                          data-testid="runtime-config-sync-source-select"
                          className="w-[152px]"
                        />
                        <SelectContent>
                          <SelectItem value="local">
                            {t('workbench.runtime_config_current_device_source', '本机')}
                          </SelectItem>
                          {onlineDevices.map(device => (
                            <SelectItem
                              key={device.device_id}
                              value={String(`device:${device.device_id}`)}
                            >
                              {device.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </SelectRoot>
                      <ControlButton
                        variant="outline"
                        size="sm"
                        type="button"
                        data-testid="runtime-config-sync-auth-button"
                        onClick={handleSyncAuthSource}
                        disabled={!canSyncAuthSource || authSyncBusy}
                      >
                        {authSyncBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        {authSourceActionLabel}
                      </ControlButton>
                    </div>
                  </div>
                </div>
              </CodexSettingsGroup>

              {notice && (
                <div
                  data-testid="runtime-config-notice"
                  className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary"
                >
                  {notice}
                </div>
              )}
              {error && (
                <div
                  data-testid="runtime-config-error"
                  className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive wework:border-red-500/20 wework:bg-red-500/10 wework:text-red-500"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </>
          ) : null}
        </CodexAuthSettingsSection>
      </div>
      <div className="mt-8">
        <ProviderSettingsSection />
      </div>
      <div className="mt-8">
        {cloudConnection.isConnected ? (
          <CloudModelsSection cloudConnection={cloudConnection} />
        ) : (
          <DisconnectedCloudModelsSection onOpenCloudSettings={onOpenCloudSettings} />
        )}
      </div>
      {restartConfirmDialog}
    </SettingsPage>
  )
}
