import { ProviderSettingsSection } from './ProviderSettingsSection'
import { CodexOfficialModelsSection } from './CodexOfficialModelsSection'
import { LocalCodexModelRow } from './LocalCodexModelRow'
import { CloudModelsSection, DisconnectedCloudModelsSection } from './CloudModelsSection'
import { AlertCircle, ChevronDown, Loader2, RefreshCw, ShieldCheck, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { getLocalCodexOfficialModels } from '@/api/local/codexOfficialModels'
import {
  cancelLocalCodexLogin,
  listLocalCodexAccounts,
  startLocalCodexLogin,
  switchLocalCodexAccount,
  type LocalCodexAccounts,
} from '@/api/local/codexAuth'
import { getLocalCodexAuthStatus, type LocalRuntimeAuthStatus } from '@/api/local/runtimeAuthStatus'
import { createModelApi } from '@/api/models'
import { createUserApi } from '@/api/users'
import type { UserRuntime, UserRuntimeConfig } from '@/api/users'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import type { CodexOfficialModelList } from '@/features/model-settings/codexOfficialModels'

import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { useTranslation } from '@/hooks/useTranslation'
import { isClaudeCodeDevice } from '@/lib/device-capabilities'
import { openExternalUrl } from '@/lib/external-links'

import { updateAppPreferences } from '@/desktop/appPreferences'
import { useLocalCodexSubscriptionEnabled } from '@/features/app-preferences/useLocalCodexSubscriptionEnabled'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'

import type { DeviceInfo } from '@/types/devices'
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSwitch,
  SettingsGroup,
  SettingsRow,
} from './settings-ui'

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
        control={
          <button
            type="button"
            data-testid={`codex-${kind}-details-toggle`}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted md:min-h-8"
            aria-expanded={expanded}
            onClick={() => setExpanded(value => !value)}
          >
            {expanded ? t('collapse') : t(kind === 'models' ? 'viewModels' : 'manageAccount')}
            <ChevronDown
              className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
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
  const [config, setConfig] = useState<UserRuntimeConfig | null>(null)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedAuthSyncSource, setSelectedAuthSyncSource] = useState('local')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [localAuthStatus, setLocalAuthStatus] = useState<LocalRuntimeAuthStatus | null>(null)
  const [localCodexAccounts, setLocalCodexAccounts] = useState<LocalCodexAccounts | null>(null)
  const [localAuthLoading, setLocalAuthLoading] = useState(true)
  const [localAuthError, setLocalAuthError] = useState<string | null>(null)
  const [switchingLocalAccountId, setSwitchingLocalAccountId] = useState<string | null>(null)
  const [localLoginState, setLocalLoginState] = useState<
    'idle' | 'starting' | 'waiting' | 'cancelling'
  >('idle')
  const [localLoginError, setLocalLoginError] = useState<string | null>(null)
  const localLoginIdRef = useRef<string | null>(null)
  const localLoginGenerationRef = useRef(0)
  const [codexOfficialModels, setCodexOfficialModels] = useState<CodexOfficialModelList | null>(
    null
  )
  const [codexOfficialLoading, setCodexOfficialLoading] = useState(true)
  const [codexOfficialError, setCodexOfficialError] = useState<string | null>(null)

  const { enabled: subscriptionEnabled, loaded: subscriptionLoaded } =
    useLocalCodexSubscriptionEnabled()
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

  const loadLocalAuthStatus = useCallback(async () => {
    setLocalAuthLoading(true)
    setLocalAuthError(null)
    try {
      const [status, accounts] = await Promise.all([
        getLocalCodexAuthStatus(),
        listLocalCodexAccounts(),
      ])
      setLocalAuthStatus(status)
      setLocalCodexAccounts(accounts)
    } catch (statusError) {
      setLocalAuthError(
        getErrorMessage(
          statusError,
          t('workbench.local_codex_auth_load_failed', '读取本机 Codex auth 状态失败')
        )
      )
    } finally {
      setLocalAuthLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!subscriptionEnabled) return
    void Promise.resolve().then(loadLocalAuthStatus)
  }, [loadLocalAuthStatus, subscriptionEnabled])

  useEffect(
    () => () => {
      localLoginGenerationRef.current += 1
      const loginId = localLoginIdRef.current
      localLoginIdRef.current = null
      if (loginId) {
        void cancelLocalCodexLogin(loginId)
      }
    },
    []
  )

  const handleLocalCodexLogin = async () => {
    if (localLoginState !== 'idle') return
    const generation = localLoginGenerationRef.current + 1
    localLoginGenerationRef.current = generation
    setLocalLoginState('starting')
    setLocalLoginError(null)
    try {
      const initialAuthSha256 = localAuthStatus?.sha256 ?? null
      const login = await startLocalCodexLogin()
      if (localLoginGenerationRef.current !== generation) {
        void cancelLocalCodexLogin(login.loginId)
        return
      }
      localLoginIdRef.current = login.loginId
      const opened = await openExternalUrl(login.authUrl, { target: 'system' })
      if (!opened) {
        throw new Error(t('workbench.local_codex_login_open_failed', '无法打开 Codex 登录页面'))
      }
      setLocalLoginState('waiting')
      const deadline = Date.now() + 5 * 60 * 1000
      while (localLoginGenerationRef.current === generation) {
        const nextStatus = await getLocalCodexAuthStatus()
        if (localLoginGenerationRef.current !== generation) return
        if (nextStatus.exists && nextStatus.sha256 !== initialAuthSha256) {
          localLoginIdRef.current = null
          setLocalLoginState('idle')
          await loadLocalAuthStatus()
          return
        }
        if (Date.now() >= deadline) {
          throw new Error(t('workbench.local_codex_login_timeout', 'Codex 登录已超时，请重试'))
        }
        await new Promise(resolve => window.setTimeout(resolve, 1000))
      }
    } catch (loginError) {
      if (localLoginGenerationRef.current !== generation) return
      const loginId = localLoginIdRef.current
      localLoginIdRef.current = null
      if (loginId) {
        try {
          await cancelLocalCodexLogin(loginId)
        } catch {
          // Preserve the primary login error.
        }
      }
      setLocalLoginState('idle')
      setLocalLoginError(
        getErrorMessage(
          loginError,
          t('workbench.local_codex_login_failed', 'Codex 登录失败，请重试')
        )
      )
    }
  }

  const handleSwitchLocalCodexAccount = async (accountId: string) => {
    if (switchingLocalAccountId || localLoginState !== 'idle') return
    setSwitchingLocalAccountId(accountId)
    setLocalLoginError(null)
    try {
      setLocalCodexAccounts(await switchLocalCodexAccount(accountId))
      setLocalAuthStatus(await getLocalCodexAuthStatus())
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    } catch (switchError) {
      setLocalLoginError(
        getErrorMessage(
          switchError,
          t(
            'workbench.local_codex_account_switch_failed',
            '切换失败，请等待正在运行的 Codex 任务结束后重试'
          )
        )
      )
    } finally {
      setSwitchingLocalAccountId(null)
    }
  }

  const handleCancelLocalCodexLogin = async () => {
    const loginId = localLoginIdRef.current
    if (!loginId || localLoginState !== 'waiting') return
    localLoginGenerationRef.current += 1
    localLoginIdRef.current = null
    setLocalLoginState('cancelling')
    setLocalLoginError(null)
    try {
      await cancelLocalCodexLogin(loginId)
    } catch (cancelError) {
      setLocalLoginError(
        getErrorMessage(
          cancelError,
          t('workbench.local_codex_login_cancel_failed', '取消 Codex 登录失败')
        )
      )
    } finally {
      setLocalLoginState('idle')
    }
  }

  const loadCodexOfficialModels = useCallback(async () => {
    setCodexOfficialLoading(true)
    setCodexOfficialError(null)
    try {
      const nextModels = await getLocalCodexOfficialModels()
      setCodexOfficialModels(nextModels)
      window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
    } catch (loadError) {
      setCodexOfficialModels(null)
      setCodexOfficialError(
        getErrorMessage(loadError, t('workbench.codex_official_models_load_failed'))
      )
    } finally {
      setCodexOfficialLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!subscriptionEnabled) return
    void Promise.resolve().then(loadCodexOfficialModels)
  }, [loadCodexOfficialModels, subscriptionEnabled])

  const loadRuntimeConfig = useCallback(
    async (refresh = false) => {
      if (!cloudConnection.isConnected) {
        setLoading(false)
        setRefreshing(false)
        return
      }
      if (refresh) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      setError(null)
      try {
        const { deviceApi, userApi } = createRuntimeSettingsApis(cloudConnection)
        const [nextConfig, nextDevices] = await Promise.all([
          userApi.getRuntimeConfig(runtime),
          deviceApi.getAllDevices(),
        ])
        setConfig(nextConfig)
        setDevices(nextDevices.filter(isClaudeCodeDevice))
      } catch (loadError) {
        setError(
          getErrorMessage(
            loadError,
            t('workbench.runtime_config_load_failed', '加载运行时配置失败')
          )
        )
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [cloudConnection, runtime, t]
  )

  useEffect(() => {
    void Promise.resolve().then(() => loadRuntimeConfig())
  }, [loadRuntimeConfig])

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
          <button
            type="button"
            data-testid="runtime-config-refresh-button"
            onClick={() => void loadRuntimeConfig(true)}
            disabled={loading || refreshing}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('workbench.runtime_config_refresh', '刷新')}
            title={t('workbench.runtime_config_refresh', '刷新')}
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
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
                      <button
                        type="button"
                        data-testid="runtime-config-toggle"
                        role="switch"
                        aria-checked={config?.use_user_config ?? false}
                        onClick={handleToggleUseUserConfig}
                        disabled={!config?.configured || updating}
                        className={[
                          'inline-flex h-6 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
                          config?.use_user_config
                            ? 'bg-primary text-primary-contrast'
                            : 'bg-background text-text-secondary hover:bg-muted hover:text-text-primary',
                        ].join(' ')}
                      >
                        {updating && <Loader2 className="h-3 w-3 animate-spin" />}
                        {config?.use_user_config
                          ? t('workbench.runtime_config_use_enabled', '自动同步开启')
                          : t('workbench.runtime_config_use_disabled', '自动同步关闭')}
                      </button>
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
                    <input
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
                      <select
                        id="runtime-config-sync-source"
                        data-testid="runtime-config-sync-source-select"
                        value={selectedAuthSyncSource}
                        onChange={event => setSelectedAuthSyncSource(event.target.value)}
                        disabled={authSyncBusy}
                        className="h-8 w-[152px] rounded-md border border-border bg-background px-2 text-sm text-text-primary disabled:cursor-not-allowed disabled:bg-muted disabled:text-text-muted"
                      >
                        <option value="local">
                          {t('workbench.runtime_config_current_device_source', '本机')}
                        </option>
                        {onlineDevices.map(device => (
                          <option key={device.device_id} value={`device:${device.device_id}`}>
                            {device.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        data-testid="runtime-config-sync-auth-button"
                        onClick={handleSyncAuthSource}
                        disabled={!canSyncAuthSource || authSyncBusy}
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {authSyncBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        {authSourceActionLabel}
                      </button>
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
                  className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
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
