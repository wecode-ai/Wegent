import { AlertCircle, Loader2, Network, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createUserApi } from '@/api/users'
import type { UserProxyConfig } from '@/api/users'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'

function createProxySettingsApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createUserApi(createHttpClient({ baseUrl: apiBaseUrl }))
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
  const [config, setConfig] = useState<UserProxyConfig | null>(null)
  const [proxyUrl, setProxyUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadProxyConfig = useCallback(async (refresh = false) => {
    if (refresh) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    setError(null)
    try {
      const nextConfig = await createProxySettingsApi().getProxyConfig()
      setConfig(nextConfig)
    } catch (loadError) {
      setError(getErrorMessage(loadError, t('workbench.proxy_config_load_failed')))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void Promise.resolve().then(() => loadProxyConfig())
  }, [loadProxyConfig])

  const handleSaveProxyUrl = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const nextConfig = await createProxySettingsApi().updateProxyConfig(
        proxyUrl.trim(),
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

  const statusLabel = config?.configured
    ? t('workbench.proxy_config_configured')
    : t('workbench.proxy_config_not_configured')
  const statusClassName = config?.configured
    ? 'bg-primary/10 text-primary'
    : 'bg-muted text-text-muted'
  const updatedAt = formatProxyDate(config?.proxy_updated_at)

  return (
    <div data-testid="proxy-settings-page" className="mx-auto w-full max-w-[820px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-text-primary">
            {t('workbench.proxy_config_title')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('workbench.proxy_config_subtitle')}
          </p>
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
          <section className="rounded-lg border border-border bg-background p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Network className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-text-primary">
                      {t('workbench.proxy_config_proxy_title')}
                    </h2>
                    <span
                      data-testid="proxy-config-status"
                      className={`rounded-full px-2 py-0.5 text-xs ${statusClassName}`}
                    >
                      {statusLabel}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {t('workbench.proxy_config_description')}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-lg bg-surface px-3 py-2">
                <div className="text-xs text-text-muted">
                  {t('workbench.proxy_config_current_proxy')}
                </div>
                <div className="mt-1 font-mono text-xs text-text-primary">
                  {config?.proxy_url_masked ||
                    t('workbench.proxy_config_no_proxy_value')}
                </div>
              </div>
              <div className="rounded-lg bg-surface px-3 py-2">
                <div className="text-xs text-text-muted">
                  {t('workbench.proxy_config_updated_at')}
                </div>
                <div className="mt-1 text-xs text-text-primary">
                  {updatedAt || t('workbench.proxy_config_never_updated')}
                </div>
              </div>
              <div className="rounded-lg bg-surface px-3 py-2 sm:col-span-2">
                <div className="flex items-center gap-1.5 text-xs text-text-muted">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t('workbench.proxy_config_secret_stored')}
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <input
                data-testid="proxy-config-url-input"
                value={proxyUrl}
                onChange={event => setProxyUrl(event.target.value)}
                disabled={saving}
                placeholder={t('workbench.proxy_config_placeholder')}
                className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="button"
                data-testid="proxy-config-save-button"
                onClick={() => void handleSaveProxyUrl()}
                disabled={saving}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving
                  ? t('workbench.proxy_config_saving')
                  : t('workbench.proxy_config_save')}
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted">
              {t('workbench.proxy_config_clear_hint')}
            </p>

            {notice && (
              <div
                data-testid="proxy-config-notice"
                className="mt-4 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary"
              >
                {notice}
              </div>
            )}
            {error && (
              <div
                data-testid="proxy-config-error"
                className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
