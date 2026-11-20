import { AlertCircle, Laptop, Loader2, Network, RefreshCw, ShieldCheck } from 'lucide-react'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { createHttpClient } from '@/api/http'
import { createUserApi } from '@/api/users'
import { resolveEffectiveLocalCodexProxy, resolveLocalCodexProxyUrl } from '@/desktop/systemProxy'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import {
  getLocalProxyConfig,
  maskLocalProxyUrl,
  saveLocalProxyConfig,
  type LocalProxyConfig,
  type LocalProxyMode,
} from '@/features/model-settings/localProxySettings'
import { useTranslation } from '@/hooks/useTranslation'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import { SettingsPage, SettingsPageHeader } from './settings-ui'

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

function createCloudProxyResource(connection: CloudProxySettingsConnection) {
  return createAsyncResource('settings/cloud-proxy', () =>
    createProxySettingsApi(connection).getProxyConfig()
  )
}

export function ProxySettingsPage() {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const connection = useMemo(
    () => ({
      isConnected: cloud.isConnected,
      apiBaseUrl: cloud.apiBaseUrl,
      token: cloud.token,
      userId: cloud.user?.id,
    }),
    [cloud.isConnected, cloud.apiBaseUrl, cloud.token, cloud.user?.id]
  )
  const ready = !!(connection.isConnected && connection.apiBaseUrl && connection.token)
  const resource = useMemo(() => createCloudProxyResource(connection), [connection])
  const [owner, setOwner] = useState({ resource, revision: 0 })
  if (owner.resource !== resource) setOwner({ resource, revision: owner.revision + 1 })
  const snapshot = useSyncExternalStore(
    ready ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot
  )
  const loading = !snapshot.settled
  const refreshing = snapshot.status === 'loading' && snapshot.settled
  return (
    <SettingsPage data-testid="proxy-settings-page">
      <SettingsPageHeader
        title={t('workbench.proxy_config_title')}
        description={t('workbench.proxy_config_subtitle')}
        actions={
          ready ? (
            <button
              type="button"
              data-testid="proxy-config-refresh-button"
              onClick={() => void resource.reload()}
              disabled={loading || refreshing}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-background text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t('workbench.proxy_config_refresh')}
              title={t('workbench.proxy_config_refresh')}
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </button>
          ) : undefined
        }
      />
      <div className="space-y-4">
        <LocalProxySettingsSection />
        {ready ? (
          <CloudProxySettingsSection
            key={owner.revision}
            connection={connection}
            resource={resource}
          />
        ) : (
          <CloudProxyUnavailableSection />
        )}
      </div>
    </SettingsPage>
  )
}

function CloudProxyUnavailableSection() {
  const { t } = useTranslation('common')
  return (
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
  )
}

function CloudProxySettingsSection({
  connection,
  resource,
}: {
  connection: CloudProxySettingsConnection
  resource: ReturnType<typeof createCloudProxyResource>
}) {
  const { t } = useTranslation('common')
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const config = snapshot.data
  const [proxyUrl, setProxyUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const [saved, setSaved] = useState(false)
  const notice = saved ? t('workbench.proxy_config_save_success') : null
  const error = failure
    ? getErrorMessage(failure.cause, t('workbench.proxy_config_save_failed'))
    : snapshot.status === 'error'
      ? getErrorMessage(snapshot.error, t('workbench.proxy_config_load_failed'))
      : null
  const statusLabel = !config
    ? snapshot.status === 'error'
      ? t('workbench.proxy_config_connection_unavailable')
      : t('common.loading')
    : config.configured
      ? t('workbench.proxy_config_configured')
      : t('workbench.proxy_config_not_configured')
  const statusClassName = config?.configured
    ? 'bg-primary/10 text-primary'
    : 'bg-muted text-text-muted'
  const updatedAt = formatProxyDate(config?.proxy_updated_at)
  const handleSaveProxyUrl = async () => {
    if (pending.current || !resource.hasSubscribers()) return
    pending.current = true
    setSaving(true)
    setFailure(null)
    setSaved(false)
    const submitted = proxyUrl
    try {
      const receipt = await createProxySettingsApi(connection).updateProxyConfig(submitted.trim())
      if (!resource.hasSubscribers()) return
      resource.update(() => receipt)
      setProxyUrl(current => (current === submitted ? '' : current))
      setSaved(true)
    } catch (cause) {
      if (resource.hasSubscribers()) setFailure({ cause })
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  return (
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

      {config && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="min-w-0">
            <span className="text-text-muted">{t('workbench.proxy_config_current_proxy')}</span>
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
      )}
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
          className="mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive wework:border-red-500/20 wework:bg-red-500/10 wework:text-red-500"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  )
}

function LocalProxySettingsSection() {
  const { t } = useTranslation('common')
  const [localConfig, setLocalConfig] = useState<LocalProxyConfig>(() => getLocalProxyConfig())
  const [localProxyMode, setLocalProxyMode] = useState<LocalProxyMode>(localConfig.mode)
  const [localProxyUrl, setLocalProxyUrl] = useState('')
  const [localSaving, setLocalSaving] = useState(false)
  const [localRestarting, setLocalRestarting] = useState(false)
  const pendingRestart = useRef(false)
  const revision = useRef(0)
  const [resource] = useState(() =>
    createAsyncResource('settings/local-effective-proxy', () => resolveEffectiveLocalCodexProxy())
  )
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const effectiveLocalProxy = snapshot.status === 'error' ? undefined : snapshot.data
  const localProxyResolving = snapshot.status === 'idle' || snapshot.status === 'loading'
  const [localRestartRequired, setLocalRestartRequired] = useState(false)
  const [localFailure, setLocalError] = useState<{ cause: unknown; fallback: string } | null>(null)
  const localError = localFailure
    ? getErrorMessage(localFailure.cause, t(localFailure.fallback))
    : snapshot.status === 'error'
      ? getErrorMessage(snapshot.error, t('workbench.proxy_config_system_resolve_failed'))
      : null
  const [localNoticeKey, setLocalNotice] = useState<string | null>(null)
  const localNotice = localNoticeKey ? t(localNoticeKey) : null
  const handleSaveLocalProxyUrl = () => {
    setLocalSaving(true)
    setLocalError(null)
    try {
      const receipt = saveLocalProxyConfig(localProxyMode, localProxyUrl)
      revision.current += 1
      setLocalConfig(receipt)
      setLocalProxyUrl('')
      setLocalRestartRequired(true)
      setLocalNotice('workbench.proxy_config_local_save_success')
      void resource.reload()
    } catch (cause) {
      setLocalError({ cause, fallback: 'workbench.proxy_config_local_save_failed' })
    } finally {
      setLocalSaving(false)
    }
  }
  const handleRestartLocalCodex = async () => {
    if (pendingRestart.current || !resource.hasSubscribers()) return
    pendingRestart.current = true
    const appliedRevision = revision.current
    setLocalRestarting(true)
    setLocalError(null)
    try {
      const proxyUrl = await resolveLocalCodexProxyUrl()
      if (!resource.hasSubscribers()) return
      await requestLocalExecutor(RESTART_CODEX_APP_SERVER_METHOD, { proxyUrl })
      if (!resource.hasSubscribers()) return
      if (revision.current === appliedRevision) {
        setLocalRestartRequired(false)
        setLocalNotice('workbench.proxy_config_local_restart_success')
      }
      void resource.reload()
    } catch (cause) {
      if (resource.hasSubscribers())
        setLocalError({ cause, fallback: 'workbench.proxy_config_local_restart_failed' })
    } finally {
      pendingRestart.current = false
      setLocalRestarting(false)
    }
  }
  const localStatusLabel =
    localConfig.mode === 'system'
      ? t('workbench.proxy_config_mode_system')
      : localConfig.mode === 'direct'
        ? t('workbench.proxy_config_mode_direct')
        : t('workbench.proxy_config_mode_custom')
  const localUpdatedAt = formatProxyDate(localConfig.updatedAt)
  const localProxyModes: Array<{
    mode: LocalProxyMode
    label: string
    description: string
  }> = [
    {
      mode: 'system',
      label: t('workbench.proxy_config_mode_system'),
      description: t('workbench.proxy_config_mode_system_description'),
    },
    {
      mode: 'direct',
      label: t('workbench.proxy_config_mode_direct'),
      description: t('workbench.proxy_config_mode_direct_description'),
    },
    {
      mode: 'custom',
      label: t('workbench.proxy_config_mode_custom'),
      description: t('workbench.proxy_config_mode_custom_description'),
    },
  ]
  const effectiveLocalProxyLabel = localProxyResolving
    ? t('workbench.proxy_config_source_resolving')
    : !effectiveLocalProxy
      ? t('workbench.proxy_config_connection_unavailable')
      : localConfig.mode === 'direct'
        ? t('workbench.proxy_config_connection_forced_direct')
        : localConfig.mode === 'custom'
          ? t('workbench.proxy_config_connection_custom_proxy', {
              proxy: maskLocalProxyUrl(effectiveLocalProxy.proxyUrl ?? ''),
            })
          : effectiveLocalProxy.proxyUrl
            ? t('workbench.proxy_config_connection_system_proxy', {
                proxy: maskLocalProxyUrl(effectiveLocalProxy.proxyUrl),
              })
            : t('workbench.proxy_config_connection_system_direct')

  return (
    <section
      data-testid="proxy-config-local-device-section"
      className="rounded-lg border border-border bg-background p-4"
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
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-text-muted"
        >
          {localStatusLabel}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="min-w-0">
          <span className="text-text-muted">{t('workbench.proxy_config_current_connection')}</span>
          <span
            data-testid="local-proxy-effective-url"
            className="ml-2 break-all font-mono text-text-primary"
          >
            {effectiveLocalProxyLabel}
          </span>
        </div>
        {localConfig.updatedAt && (
          <div>
            <span className="text-text-muted">{t('workbench.proxy_config_updated_at')}</span>
            <span className="ml-2 text-text-primary">
              {localUpdatedAt || t('workbench.proxy_config_never_updated')}
            </span>
          </div>
        )}
      </div>

      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium text-text-secondary">
          {t('workbench.proxy_config_mode_label')}
        </legend>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
          {localProxyModes.map(option => {
            const selected = localProxyMode === option.mode
            return (
              <label
                key={option.mode}
                className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                  selected
                    ? 'border-text-primary bg-surface'
                    : 'border-border bg-background hover:bg-surface'
                }`}
              >
                <input
                  type="radio"
                  name="local-proxy-mode"
                  value={option.mode}
                  checked={selected}
                  onChange={() => {
                    setLocalProxyMode(option.mode)
                    setLocalError(null)
                  }}
                  disabled={localSaving}
                  data-testid={`local-proxy-mode-${option.mode}`}
                  className="sr-only"
                />
                <span className="block text-sm font-medium text-text-primary">{option.label}</span>
                <span className="mt-1 block text-xs leading-5 text-text-muted">
                  {option.description}
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {localProxyMode === 'custom' && (
          <input
            data-testid="local-proxy-config-url-input"
            value={localProxyUrl}
            onChange={event => setLocalProxyUrl(event.target.value)}
            disabled={localSaving}
            placeholder={t('workbench.proxy_config_placeholder')}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50"
          />
        )}
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
          className="mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive wework:border-red-500/20 wework:bg-red-500/10 wework:text-red-500"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span>{localError}</span>
            {snapshot.status === 'error' && (
              <button
                type="button"
                data-testid="local-proxy-config-retry-resolution"
                onClick={() => void resource.reload()}
                className="ml-2 min-h-11 rounded-md border border-border px-3 text-sm md:min-h-8"
              >
                {t('common.retry')}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
