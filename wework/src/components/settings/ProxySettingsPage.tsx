import { AlertCircle, Laptop, Loader2, Network, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createUserApi } from '@/api/users'
import type { UserProxyConfig } from '@/api/users'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import {
  getLocalProxyConfig,
  saveLocalProxyUrl,
  type LocalProxyConfig,
} from '@/features/model-settings/localProxySettings'
import { useTranslation } from '@/hooks/useTranslation'
import { requestLocalExecutor } from '@/tauri/localExecutor'

const RESTART_CODEX_APP_SERVER_METHOD = 'runtime.codex.app_server.restart'

interface CloudProxySettingsConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
}

function createProxySettingsApi(connection: CloudProxySettingsConnection) {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }
  return createUserApi(
    createHttpClient({
      baseUrl: connection.apiBaseUrl,
      getToken: () => connection.token,
      redirectOnUnauthorized: false,
    })
  )
}

function formatProxyDate(value?: string | null) {
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

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export function ProxySettingsPage() {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const [config, setConfig] = useState<UserProxyConfig | null>(null)
  const [localConfig, setLocalConfig] = useState<LocalProxyConfig>(() => getLocalProxyConfig())
  const [proxyUrl, setProxyUrl] = useState('')
  const [localProxyUrl, setLocalProxyUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [localSaving, setLocalSaving] = useState(false)
  const [localRestarting, setLocalRestarting] = useState(false)
  const [localRestartRequired, setLocalRestartRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [localNotice, setLocalNotice] = useState<string | null>(null)

  const loadProxyConfig = useCallback(
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
        const nextConfig = await createProxySettingsApi(cloudConnection).getProxyConfig()
        setConfig(nextConfig)
      } catch (loadError) {
        setError(getErrorMessage(loadError, t('workbench.proxy_config_load_failed')))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [cloudConnection, t]
  )

  useEffect(() => {
    void Promise.resolve().then(() => loadProxyConfig())
  }, [loadProxyConfig])

  const handleSaveProxyUrl = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const nextConfig = await createProxySettingsApi(cloudConnection).updateProxyConfig(
        proxyUrl.trim()
      )
      setConfig(nextConfig)
      setProxyUrl('')
      setNotice(t('workbench.proxy_config_save_success'))
    } catch (saveError) {
      setError(getErrorMessage(saveError, t('workbench.proxy_config_save_failed')))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveLocalProxyUrl = async () => {
    if (localSaving) return
    setLocalSaving(true)
    setLocalError(null)
    setLocalNotice(null)
    try {
      const nextConfig = saveLocalProxyUrl(localProxyUrl)
      setLocalConfig(nextConfig)
      setLocalProxyUrl('')
      setLocalRestartRequired(true)
      setLocalNotice(t('workbench.proxy_config_local_save_success'))
    } catch (saveError) {
      setLocalConfig(getLocalProxyConfig())
      setLocalError(getErrorMessage(saveError, t('workbench.proxy_config_local_save_failed')))
    } finally {
      setLocalSaving(false)
    }
  }

  const handleRestartLocalCodex = async () => {
    if (localRestarting) return
    setLocalRestarting(true)
    setLocalError(null)
    try {
      await requestLocalExecutor(RESTART_CODEX_APP_SERVER_METHOD)
      setLocalRestartRequired(false)
      setLocalNotice(t('workbench.proxy_config_local_restart_success'))
    } catch (restartError) {
      setLocalError(getErrorMessage(restartError, t('workbench.proxy_config_local_restart_failed')))
    } finally {
      setLocalRestarting(false)
    }
  }

  const statusLabel = config?.configured
    ? t('workbench.proxy_config_configured')
    : t('workbench.proxy_config_not_configured')
  const statusClassName = config?.configured
    ? 'bg-primary/10 text-primary'
    : 'bg-muted text-text-muted'
  const updatedAt = formatProxyDate(config?.proxy_updated_at)
  const localStatusLabel = localConfig.configured
    ? t('workbench.proxy_config_configured')
    : t('workbench.proxy_config_not_configured')
  const localStatusClassName = localConfig.configured
    ? 'bg-primary/10 text-primary'
    : 'bg-muted text-text-muted'
  const localUpdatedAt = formatProxyDate(localConfig.updatedAt)

  const renderLocalProxySection = (className = '') => (
    <section
      data-testid="proxy-config-local-device-section"
      className={`rounded-lg border border-border bg-background p-4 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Laptop className="h-4 w-4 text-text-secondary" />
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.proxy_config_local_title')}
            </h2>
          </div>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            {t('workbench.proxy_config_local_description')}
          </p>
        </div>
        <span
          data-testid="local-proxy-config-status"
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${localStatusClassName}`}
        >
          {localStatusLabel}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="min-w-0">
          <span className="text-text-muted">{t('workbench.proxy_config_current_proxy')}</span>
          <span className="ml-2 break-all font-mono text-text-primary">
            {localConfig.proxyUrlMasked || t('workbench.proxy_config_no_proxy_value')}
          </span>
        </div>
        <div>
          <span className="text-text-muted">{t('workbench.proxy_config_updated_at')}</span>
          <span className="ml-2 text-text-primary">
            {localUpdatedAt || t('workbench.proxy_config_never_updated')}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          data-testid="local-proxy-config-url-input"
          value={localProxyUrl}
          onChange={event => setLocalProxyUrl(event.target.value)}
          disabled={localSaving}
          placeholder={t('workbench.proxy_config_placeholder')}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="button"
          data-testid="local-proxy-config-save-button"
          onClick={() => void handleSaveLocalProxyUrl()}
          disabled={localSaving}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {localSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {localSaving ? t('workbench.proxy_config_saving') : t('workbench.proxy_config_save')}
        </button>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-muted">
        {t('workbench.proxy_config_local_clear_hint')}
      </p>

      {localNotice && (
        <div
          data-testid="local-proxy-config-notice"
          className="mt-3 flex flex-col gap-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary sm:flex-row sm:items-center sm:justify-between"
        >
          <span>{localNotice}</span>
          {localRestartRequired && (
            <button
              type="button"
              data-testid="local-proxy-config-restart-codex-button"
              onClick={() => void handleRestartLocalCodex()}
              disabled={localRestarting}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-text-primary px-3 text-xs font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {localRestarting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {localRestarting
                ? t('workbench.proxy_config_local_restarting')
                : t('workbench.proxy_config_local_restart_action')}
            </button>
          )}
        </div>
      )}
      {localError && (
        <div
          data-testid="local-proxy-config-error"
          className="mt-3 flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{localError}</span>
        </div>
      )}
    </section>
  )

  if (!cloudConnection.isConnected) {
    return (
      <div data-testid="proxy-settings-page" className="mx-auto w-full max-w-[820px]">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.proxy_config_title')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">{t('workbench.proxy_config_subtitle')}</p>
        </div>
        <div className="mt-8 space-y-4">
          {renderLocalProxySection()}
          <section
            data-testid="proxy-config-cloud-required"
            className="rounded-lg border border-dashed border-border bg-background p-4"
          >
            <div className="flex items-start gap-3">
              <Network className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">
                  {t('workbench.proxy_config_proxy_title')}
                </h2>
                <p className="mt-1 text-sm leading-6 text-text-secondary">
                  {t('workbench.proxy_config_cloud_required_desc')}
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="proxy-settings-page" className="mx-auto w-full max-w-[820px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.proxy_config_title')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">{t('workbench.proxy_config_subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="proxy-config-refresh-button"
          onClick={() => void loadProxyConfig(true)}
          disabled={loading || refreshing}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-surface text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('workbench.proxy_config_refresh')}
          title={t('workbench.proxy_config_refresh')}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="mt-8">
        {loading ? (
          <div className="py-8 text-center text-sm text-text-secondary">
            {t('common.loading', '加载中...')}
          </div>
        ) : (
          <div className="space-y-4">
            {renderLocalProxySection()}

            <section
              data-testid="proxy-config-cloud-device-section"
              className="rounded-lg border border-border bg-background p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Network className="h-4 w-4 text-text-secondary" />
                    <h2 className="text-sm font-semibold text-text-primary">
                      {t('workbench.proxy_config_proxy_title')}
                    </h2>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {t('workbench.proxy_config_description')}
                  </p>
                </div>
                <span
                  data-testid="proxy-config-status"
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusClassName}`}
                >
                  {statusLabel}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                <div className="min-w-0">
                  <span className="text-text-muted">
                    {t('workbench.proxy_config_current_proxy')}
                  </span>
                  <span className="ml-2 break-all font-mono text-text-primary">
                    {config?.proxy_url_masked || t('workbench.proxy_config_no_proxy_value')}
                  </span>
                </div>
                <div>
                  <span className="text-text-muted">{t('workbench.proxy_config_updated_at')}</span>
                  <span className="ml-2 text-text-primary">
                    {updatedAt || t('workbench.proxy_config_never_updated')}
                  </span>
                </div>
              </div>

              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input
                  data-testid="proxy-config-url-input"
                  value={proxyUrl}
                  onChange={event => setProxyUrl(event.target.value)}
                  disabled={saving}
                  placeholder={t('workbench.proxy_config_placeholder')}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50"
                />
                <button
                  type="button"
                  data-testid="proxy-config-save-button"
                  onClick={() => void handleSaveProxyUrl()}
                  disabled={saving}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {saving ? t('workbench.proxy_config_saving') : t('workbench.proxy_config_save')}
                </button>
              </div>

              <div className="mt-2 flex items-center gap-1.5 text-xs leading-5 text-text-muted">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                <span>{t('workbench.proxy_config_secret_stored')}</span>
              </div>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                {t('workbench.proxy_config_clear_hint')}
              </p>

              {notice && (
                <div
                  data-testid="proxy-config-notice"
                  className="mt-3 rounded-md border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary"
                >
                  {notice}
                </div>
              )}
              {error && (
                <div
                  data-testid="proxy-config-error"
                  className="mt-3 flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}
