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
import { openConnectorAuthorizationWindow } from '@/lib/connector-authorization-window'
import type { useTranslation } from '@/hooks/useTranslation'
export type ConnectorConnectionRow = WegentInstalledConnectorApp & {
  name: string
  auth_type: WegentConnectorApp['auth_type']
}

export interface ConnectorConnectionsProps {
  apiBaseUrl: string | null
  token: string | null
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

/** Catalog reads and authorization receipts are fenced by one settings account owner. */
export function createConnectorConnectionsSource({ apiBaseUrl, token }: ConnectorConnectionsProps) {
  let snapshot = {
    apps: [] as ConnectorConnectionRow[],
    loading: Boolean(apiBaseUrl && token),
    error: null as string | null,
    pendingSlug: null as string | null,
  }
  const listeners = new Set<() => void>()
  let translator: ReturnType<typeof useTranslation>['t'] | undefined
  let epoch = 0
  let readRevision = 0
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const active = () => listeners.size > 0
  async function load() {
    if (!apiBaseUrl || !token || !active() || !translator) return
    const revision = ++readRevision
    const generation = epoch
    const t = translator
    const current = () => active() && generation === epoch && revision === readRevision
    try {
      const [installed, catalog] = await Promise.all([
        listWegentInstalledConnectorApps(apiBaseUrl, token),
        listWegentConnectorApps(apiBaseUrl, token),
      ])
      if (current()) publish({ apps: mergeConnectorRows(catalog, installed.apps), error: null })
    } catch {
      if (current()) publish({ error: t('workbench.connector_connections_load_failed') })
    } finally {
      if (current()) publish({ loading: false })
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, t: NonNullable<typeof translator>) {
      const shouldLoad = !active() || translator !== t
      translator = t
      listeners.add(listener)
      if (shouldLoad) void load()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (!active()) {
            epoch++
            readRevision++
          }
        })
      }
    },
    retry: load,
    async updateConnection(app: ConnectorConnectionRow, action: 'refresh' | 'authorize') {
      if (!apiBaseUrl || !token || !active() || !translator) return
      const generation = epoch
      const t = translator
      const current = () => active() && generation === epoch
      publish({ pendingSlug: app.slug, error: null })
      try {
        if (action === 'refresh') {
          await refreshWegentConnector(apiBaseUrl, token, app.slug)
          if (!current()) return
          notifyConnectorAuthorizationChanged()
        } else {
          await authorizeWegentConnector(
            apiBaseUrl,
            token,
            app.slug,
            openConnectorAuthorizationWindow,
            { isCurrent: current }
          )
        }
        if (current()) void load()
      } catch (cause) {
        if (!current() || (cause as { name?: string } | null)?.name === 'AbortError') return
        publish({
          error:
            action === 'refresh'
              ? cause instanceof Error
                ? cause.message
                : t('workbench.connector_refresh_failed')
              : connectorAuthorizationErrorMessage(cause, app.name, t),
        })
      } finally {
        if (current()) publish({ pendingSlug: null })
      }
    },
  }
}
