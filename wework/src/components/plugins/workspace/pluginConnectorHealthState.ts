import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { useDOMEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import { LOCAL_CONNECTOR_AUTH_CHANGED_EVENT } from '@/api/local/localConnectorAuthEvents'
import { isGithubCliTarget } from '@/api/local/githubCli'
import {
  localConnectorAuthHealth,
  localQrManageActionFromHealth,
  pluginLocalConnectorAuthTarget,
} from '@/api/local/localConnectorAuth'
import { getErrorMessage } from '@/lib/error-message'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { isCloudManagedInstalledPlugin, isWegentManagedStorePlugin } from '../installedPluginMerge'
import { installedPluginMarketplaceId } from '../pluginDistribution'
import type { PluginCatalogInput } from './pluginCatalogState'

interface HealthInput {
  detail: InstalledPluginItem | null
  t: PluginCatalogInput['t']
  revision: number
  busy: boolean
}
interface HealthReadReceipt {
  isCurrent(): boolean
}

export function createPluginConnectorHealthState(key: string) {
  let input: HealthInput | undefined
  let snapshot: { states: Record<string, 'connected' | 'disconnected'>; error: string | null } = {
    states: {},
    error: null,
  }
  let generation = 0
  let request = 0
  let operation = 0
  let latestRead:
    | {
        request: number
        generation: number
        operation: number
        promise: Promise<HealthReadReceipt | null>
      }
    | undefined
  const invalidateOperation = () => {
    operation += 1
    request += 1
    latestRead = undefined
  }
  // A superseding health read may carry the same explicit intent, never a newer action.
  const followRead = (read: number, version: number, action: number) => {
    const next = latestRead
    return next && next.request > read && next.generation === version && next.operation === action
      ? next.promise
      : null
  }
  let initialized = false
  const observers = new Set<() => void>()
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    observers.forEach(listener => listener())
  }
  const refresh = (): Promise<HealthReadReceipt | null> => {
    const latest = input
    if (!latest || !observers.size) return Promise.resolve(null)
    const read = ++request
    if (latest.busy) return Promise.resolve(null)
    const plugin = latest.detail?.raw
    const marketplaceId = plugin ? (installedPluginMarketplaceId(plugin) ?? '') : ''
    const connectors = (plugin?.spec.components.connectors ?? []).flatMap(connector => {
      if (!plugin) return []
      const target = pluginLocalConnectorAuthTarget(
        plugin.spec.source.pluginKey,
        marketplaceId,
        connector,
        isCloudManagedInstalledPlugin(plugin) || isWegentManagedStorePlugin(plugin)
      )
      return target ? [{ connector, target }] : []
    })
    if (!connectors.length) {
      if (Object.keys(snapshot.states).length || snapshot.error)
        publish({ states: {}, error: null })
      return Promise.resolve(null)
    }
    const version = generation
    const action = operation
    const pending: Promise<HealthReadReceipt | null> = Promise.all(
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
      if (!observers.size || generation !== version || operation !== action) return null
      if (read !== request) return followRead(read, version, action)
      publish({
        states: Object.fromEntries(
          entries.flatMap(([slug, state]) => {
            const known = state ?? snapshot.states[slug]
            return known ? [[slug, known]] : []
          })
        ),
        error: entries.find(([, , error]) => error)?.[2] ?? null,
      })
      if (read !== request) return followRead(read, version, action)
      return {
        isCurrent: () =>
          observers.size > 0 && generation === version && operation === action && !input?.busy,
      }
    })
    latestRead = { request: read, generation: version, operation: action, promise: pending }
    return pending
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
      if (input && (input.revision !== next.revision || input.busy !== next.busy))
        invalidateOperation()
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
            invalidateOperation()
            initialized = false
          }
        })
      }
    },
    refresh,
    clearError() {
      invalidateOperation()
      if (snapshot.error !== null) publish({ error: null })
    },
    clear() {
      invalidateOperation()
      publish({ states: {}, error: null })
    },
    remember(slug: string, connected: 'connected' | 'disconnected') {
      if (!observers.size) return
      invalidateOperation()
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

interface PluginConnectorActionFailure {
  pluginId: string | number
  message: string
  source?: 'detail-read' | 'auth-health'
}

/** Only a newly admitted explicit health read can retire the error it observed. */
export function usePluginConnectorHealth(
  input: HealthInput & {
    scope: readonly unknown[]
    actionError: PluginConnectorActionFailure | null
    setActionError: Dispatch<SetStateAction<PluginConnectorActionFailure | null>>
    captureScope(): () => boolean
  }
) {
  const key = JSON.stringify(input.scope)
  const source = useMemo(() => createPluginConnectorHealthState(key), [key])
  const observation = useMemo(
    () => ({ detail: input.detail, t: input.t, revision: input.revision, busy: input.busy }),
    [input.detail, input.t, input.revision, input.busy]
  )
  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(observation, notify),
    [source, observation]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  const refresh = () => {
    const observedError = input.actionError
    const isCurrent = input.captureScope()
    void source.refresh().then(receipt => {
      if (!receipt?.isCurrent() || !isCurrent() || observedError?.source === 'detail-read') return
      input.setActionError(current => (current === observedError ? null : current))
    })
  }
  useWindowEvent('focus', refresh)
  useDOMEvent('window', LOCAL_CONNECTOR_AUTH_CHANGED_EVENT, refresh)
  return { source, snapshot }
}
