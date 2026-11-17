import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  authorizeWegentConnector,
  connectorAuthorizationErrorMessage,
  listWegentConnectorApps,
  listWegentInstalledConnectorApps,
  notifyConnectorAuthorizationChanged,
  refreshWegentConnector,
  type WegentConnectorApp,
  type WegentInstalledConnectorApp,
} from '@/api/cloud/connectorApps'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { openCloudAuthorizationWindow } from '@/lib/cloud-authorization-window'

type ConnectorConnectionRow = WegentInstalledConnectorApp & {
  name: string
  auth_type: WegentConnectorApp['auth_type']
}

interface ConnectorConnectionsProps {
  apiBaseUrl: string | null
  token: string | null
}

/** Account changes replace the whole session without placing credentials in keys. */
export function ConnectorConnectionsSection(props: ConnectorConnectionsProps) {
  const [scope, setScope] = useState({ ...props, generation: 0 })
  if (scope.apiBaseUrl !== props.apiBaseUrl || scope.token !== props.token) {
    setScope({ ...props, generation: scope.generation + 1 })
  }
  return <ConnectorConnectionsSession key={scope.generation} {...props} />
}

function mergeConnectorRows(
  catalog: WegentConnectorApp[],
  installed: WegentInstalledConnectorApp[]
): ConnectorConnectionRow[] {
  const installedBySlug = new Map(installed.map(app => [app.slug, app]))
  return catalog.map(app => {
    const installedApp = installedBySlug.get(app.slug)
    return {
      id: app.slug,
      slug: app.slug,
      name: app.name,
      description: app.description,
      icon_url: app.icon_url,
      auth_type: app.auth_type,
      runtime_name: installedApp?.runtime_name ?? null,
      enabled: installedApp?.enabled ?? true,
      callable: installedApp?.callable ?? false,
      tool_loading_mode:
        (installedApp?.tool_loading_mode ?? app.tool_loading_mode) === 'lazy' ? 'lazy' : 'static',
      connection: installedApp?.connection ?? app.connection,
      tool_summaries: installedApp?.tool_summaries ?? [],
    }
  })
}

function ConnectorConnectionsSession({ apiBaseUrl, token }: ConnectorConnectionsProps) {
  const { t } = useTranslation('common')
  const activeRef = useRef(false)
  const [apps, setApps] = useState<ConnectorConnectionRow[]>([])
  const [loading, setLoading] = useState(Boolean(apiBaseUrl && token))
  const [error, setError] = useState<string | null>(null)
  const [pendingSlug, setPendingSlug] = useState<string | null>(null)
  const [loadRevision, setLoadRevision] = useState(0)

  useLayoutEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!apiBaseUrl || !token) return
    let cancelled = false
    void Promise.all([
      listWegentInstalledConnectorApps(apiBaseUrl, token),
      listWegentConnectorApps(apiBaseUrl, token),
    ])
      .then(([installed, catalog]) => {
        if (cancelled) return
        setApps(mergeConnectorRows(catalog, installed.apps))
        setError(null)
      })
      .catch(() => {
        if (!cancelled) setError(t('workbench.connector_connections_load_failed'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl, token, t, loadRevision])

  const updateConnection = async (app: ConnectorConnectionRow, action: 'refresh' | 'authorize') => {
    if (!apiBaseUrl || !token) return
    setPendingSlug(app.slug)
    setError(null)
    try {
      if (action === 'refresh') {
        await refreshWegentConnector(apiBaseUrl, token, app.slug)
        if (!activeRef.current) return
        notifyConnectorAuthorizationChanged()
      } else {
        await authorizeWegentConnector(apiBaseUrl, token, app.slug, openCloudAuthorizationWindow, {
          isCurrent: () => activeRef.current,
        })
      }
      if (activeRef.current) setLoadRevision(revision => revision + 1)
    } catch (cause) {
      if (!activeRef.current || (cause as { name?: string } | null)?.name === 'AbortError') return
      setError(
        action === 'refresh'
          ? cause instanceof Error
            ? cause.message
            : t('workbench.connector_refresh_failed')
          : connectorAuthorizationErrorMessage(cause, app.name, t)
      )
    } finally {
      if (activeRef.current) setPendingSlug(null)
    }
  }

  return (
    <section
      className="rounded-lg border border-border bg-background p-5"
      data-testid="connector-connections-section"
    >
      <h2 className="mb-4 text-sm font-semibold text-text-primary">
        {t('workbench.connector_connections_title')}
      </h2>
      {error ? (
        <div className="mb-3 flex items-center justify-between gap-3">
          <p
            className="text-sm text-destructive"
            role="alert"
            data-testid="connector-connections-error"
          >
            {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-testid="connector-connections-retry"
            onClick={() => setLoadRevision(revision => revision + 1)}
            disabled={pendingSlug !== null}
          >
            {t('workbench.retry')}
          </Button>
        </div>
      ) : null}
      {loading ? (
        <div className="py-6 text-center text-sm text-text-secondary">{t('common.loading')}</div>
      ) : apps.length === 0 ? (
        !error && (
          <div className="py-6 text-center text-sm text-text-secondary">
            {t('workbench.connector_connections_empty')}
          </div>
        )
      ) : (
        <div className="divide-y divide-border/60">
          {apps.map(app => {
            const expired = app.connection.status === 'expired'
            const busy = pendingSlug === app.slug
            return (
              <div
                key={app.slug}
                className="flex items-center justify-between gap-4 py-3"
                data-testid={`connector-connection-${app.slug}`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">
                    {app.runtime_name ?? app.name}
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {t(
                      expired
                        ? 'workbench.connector_connection_expired'
                        : app.connection.status === 'connected'
                          ? 'workbench.connector_connection_connected'
                          : 'workbench.connector_connection_not_authorized'
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {expired ? (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid={`connector-refresh-${app.slug}`}
                      disabled={pendingSlug !== null}
                      aria-busy={busy}
                      onClick={() => void updateConnection(app, 'refresh')}
                    >
                      {busy ? t('common.loading') : t('workbench.connector_refresh')}
                    </Button>
                  ) : null}
                  {app.connection.status !== 'connected' && app.auth_type === 'oauth2' ? (
                    <Button
                      size="sm"
                      data-testid={`connector-authorize-${app.slug}`}
                      disabled={pendingSlug !== null}
                      aria-busy={busy}
                      onClick={() => void updateConnection(app, 'authorize')}
                    >
                      {busy ? t('common.loading') : t('workbench.plugins_connector_auth_action')}
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
