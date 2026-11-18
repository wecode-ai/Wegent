import {
  createConnectorConnectionsSource,
  type ConnectorConnectionsProps,
} from './connectorConnectionsSource'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

/** Account changes replace the whole session without placing credentials in keys. */
export function ConnectorConnectionsSection(props: ConnectorConnectionsProps) {
  const [scope, setScope] = useState({ ...props, generation: 0 })
  if (scope.apiBaseUrl !== props.apiBaseUrl || scope.token !== props.token) {
    setScope({ ...props, generation: scope.generation + 1 })
  }
  return <ConnectorConnectionsSession key={scope.generation} {...props} />
}

function ConnectorConnectionsSession({ apiBaseUrl, token }: ConnectorConnectionsProps) {
  const { t } = useTranslation('common')
  const [source] = useState(() => createConnectorConnectionsSource({ apiBaseUrl, token }))
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener, t),
    [source, t]
  )
  const { apps, loading, error, pendingSlug } = useSyncExternalStore(
    subscribe,
    source.getSnapshot,
    source.getSnapshot
  )
  const updateConnection = source.updateConnection

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
            onClick={() => void source.retry()}
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
