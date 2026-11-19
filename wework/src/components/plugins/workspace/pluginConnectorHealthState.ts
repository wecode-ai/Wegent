import { isGithubCliTarget } from '@/api/local/githubCli'
import {
  localConnectorAuthHealth,
  localQrManageActionFromHealth,
  pluginLocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { getErrorMessage } from '@/lib/error-message'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginCatalogInput } from './pluginCatalogState'

interface HealthInput {
  detail: InstalledPluginItem | null
  t: PluginCatalogInput['t']
  revision: number
  busy: boolean
}
export function createPluginConnectorHealthState(key: string) {
  let input: HealthInput | undefined
  let snapshot: { states: Record<string, 'connected' | 'disconnected'>; error: string | null } = {
    states: {},
    error: null,
  }
  let generation = 0
  let request = 0
  let initialized = false
  const observers = new Set<() => void>()
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    observers.forEach(listener => listener())
  }
  const refresh = () => {
    const latest = input
    if (!latest || !observers.size) return
    const read = ++request
    if (latest.busy) return
    const detail = latest.detail
    const pluginKey = detail?.raw.spec.source.pluginKey ?? ''
    const marketplaceId =
      detail?.raw.spec.source.marketplace || String(detail?.raw.metadata.namespace ?? '')
    const connectors = (detail?.raw.spec.components.connectors ?? []).flatMap(connector => {
      const target = pluginLocalConnectorAuthTarget(pluginKey, marketplaceId, connector)
      return target ? [{ connector, target }] : []
    })
    if (!connectors.length) {
      if (Object.keys(snapshot.states).length || snapshot.error)
        publish({ states: {}, error: null })
      return
    }
    const version = generation
    void Promise.all(
      connectors.map(async ({ connector, target }) => {
        try {
          const health = await localConnectorAuthHealth(target)
          if (health.status === 'error')
            throw new Error(
              isGithubCliTarget(target)
                ? latest.t(`workbench.${health.errorCode || 'gh_health_failed'}`, {
                    defaultValue: latest.t('workbench.gh_health_failed'),
                  })
                : latest.t('workbench.plugins_local_auth_health_failed')
            )
          return [
            connector.slug,
            localQrManageActionFromHealth(health) === 'logout' ? 'connected' : 'disconnected',
            null,
          ] as const
        } catch (error) {
          return [
            connector.slug,
            null,
            getErrorMessage(error, latest.t('workbench.plugins_local_auth_health_failed')),
          ] as const
        }
      })
    ).then(entries => {
      if (!observers.size || generation !== version || read !== request) return
      publish({
        states: Object.fromEntries(
          entries.flatMap(([slug, state]) => {
            const known = state ?? snapshot.states[slug]
            return known ? [[slug, known]] : []
          })
        ),
        error: entries.find(([, , error]) => error)?.[2] ?? null,
      })
    })
  }
  return {
    key,
    getSnapshot: () => snapshot,
    isCurrent: () => observers.size > 0,
    subscribe(next: HealthInput, listener: () => void) {
      const changed =
        !input ||
        input.detail !== next.detail ||
        input.t !== next.t ||
        input.revision !== next.revision ||
        input.busy !== next.busy
      input = next
      observers.add(listener)
      if (changed || !initialized) {
        initialized = true
        refresh()
      }
      return () => {
        observers.delete(listener)
        queueMicrotask(() => {
          if (!observers.size) {
            generation += 1
            request += 1
            initialized = false
          }
        })
      }
    },
    refresh,
    clearError() {
      request += 1
      if (snapshot.error !== null) publish({ error: null })
    },
    clear() {
      request += 1
      publish({ states: {}, error: null })
    },
    remember(slug: string, connected: 'connected' | 'disconnected') {
      if (!observers.size) return
      request += 1
      publish({ states: { ...snapshot.states, [slug]: connected }, error: null })
    },
  }
}

/** Foreground failures remain visible independently of optional background health. */
export function pluginConnectorActionError(
  action: {
    pluginId: string | number
    message: string
    source?: 'detail-read' | 'auth-health'
  } | null,
  detailId: string | number | null,
  healthError: string | null
) {
  if (action && String(action.pluginId) === String(detailId)) return action
  return healthError && detailId !== null
    ? { pluginId: detailId, message: healthError, source: 'auth-health' as const }
    : null
}
