import { raceWithTimeout } from '@/lib/promise-timeout'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import { useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import {
  runnerModelCatalog,
  runnerModelKey,
  type RunnerModelCatalogEntry,
  type RunnerModelIdentity,
  type WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import type { UnifiedModel } from '@/types/api'
import { isSameModelSelection } from '@wegent/collaboration/controls/model-ui'

type CatalogSource = 'native' | 'cloud'
interface SourceState {
  entries: RunnerModelCatalogEntry[]
  valid: boolean
  pending: boolean
  error: string | null
}
interface CatalogResult {
  entries: RunnerModelCatalogEntry[]
  error?: unknown
}
const emptySource = (): SourceState => ({ entries: [], valid: false, pending: false, error: null })

function isAuthorizationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { status, code } = error as { status?: unknown; code?: unknown }
  return (
    status === 401 ||
    status === 403 ||
    (typeof code === 'string' &&
      ['authentication_required', 'permission_denied', 'http_401', 'http_403'].includes(code))
  )
}

function publishedSource(previous: SourceState, result: CatalogResult): SourceState {
  const baseline = isAuthorizationFailure(result.error) ? emptySource() : previous
  const retained = result.error && baseline.valid ? baseline.entries : []
  return {
    entries: result.error
      ? [
          ...new Map(
            [...retained, ...result.entries].map(entry => [runnerModelKey(entry.identity), entry])
          ).values(),
        ]
      : result.entries,
    valid: !result.error || baseline.valid || result.entries.length > 0,
    pending: false,
    error: result.error ? getStandInErrorMessage(result.error) : null,
  }
}

/** A device/runtime catalog owns its independent source revisions and subscriptions. */
function createStandInModelCatalog(
  services: WorkbenchServices | undefined,
  deviceId: string | undefined,
  runtime: RunnerModelIdentity['runtime']
) {
  let snapshot = { native: emptySource(), cloud: emptySource() }
  const listeners = new Set<() => void>()
  const revisions = { native: 0, cloud: 0 }
  let unsubscribe: (() => void) | undefined
  const publish = (source: CatalogSource, state: SourceState) => {
    snapshot = { ...snapshot, [source]: state }
    listeners.forEach(listener => listener())
  }
  const loadSource = async (
    source: CatalogSource,
    read: () => Promise<CatalogResult>,
    invalidate = false
  ) => {
    const revision = ++revisions[source]
    publish(source, {
      ...(invalidate ? emptySource() : snapshot[source]),
      pending: true,
      error: null,
    })
    let result: CatalogResult
    try {
      result = await raceWithTimeout(read(), 15_000, () =>
        Object.assign(new Error('Model catalog timed out'), { code: 'model_catalog_timeout' })
      )
    } catch (error) {
      result = { entries: [], error }
    }
    if (listeners.size && revision === revisions[source]) {
      if (result.error) reportStandInError(`load_${source}_model_catalog`, result.error, deviceId)
      publish(source, publishedSource(snapshot[source], result))
    }
  }
  const load = (invalidateNative = false, forceRefresh = false) => {
    if (!listeners.size || !services?.standInApi || !deviceId) return
    void loadSource(
      'native',
      async () => {
        const response = await services.standInApi!.catalog(deviceId)
        const prefix = runtime === 'claude_code' ? 'claude_' : 'codex_'
        const code = response.errors?.find(error => error.startsWith(prefix))
        return {
          entries: runnerModelCatalog(response.models, [], runtime),
          error: code ? { code } : undefined,
        }
      },
      invalidateNative
    )
    loadCloud(forceRefresh)
  }
  const loadCloud = (forceRefresh = false) => {
    if (!services || !listeners.size) return
    void loadSource('cloud', async () => ({
      entries: runnerModelCatalog(
        [],
        (await services.modelApi.listModels(forceRefresh ? { forceRefresh: true } : undefined))
          .data,
        runtime
      ),
    }))
  }
  return {
    getSnapshot: () => snapshot,
    invalidateNative: () => load(true),
    refresh() {
      if (!listeners.size || !services?.standInApi || !deviceId) return
      services.modelApi.refresh?.()
      load(false, true)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1 && services?.standInApi && deviceId) {
        unsubscribe = services.modelApi.subscribe?.(() => loadCloud())
        const initialRevision = revisions.native
        queueMicrotask(() => {
          if (listeners.size && revisions.native === initialRevision) load()
        })
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          unsubscribe?.()
          unsubscribe = undefined
          revisions.native++
          revisions.cloud++
          // Retain display metadata, but revalidate identities on the next subscription.
          snapshot = {
            native: { ...snapshot.native, valid: false, pending: false },
            cloud: { ...snapshot.cloud, valid: false, pending: false },
          }
        }
      }
    },
  }
}

/** Model references remain device-scoped; credentials are resolved by the Executor. */
export function useStandInModels(
  services: WorkbenchServices | undefined,
  draft: WorkspaceStandInSettings,
  runtime: RunnerModelIdentity['runtime'] = draft.model?.runtime ?? 'codex',
  active = true
) {
  const deviceId = draft.executionDeviceId
  const store = useMemo(
    () => createStandInModelCatalog(services, deviceId, runtime),
    [services, deviceId, runtime]
  )
  const catalog = useSyncExternalStore(
    active ? store.subscribe : subscribeIdleResource,
    store.getSnapshot,
    store.getSnapshot
  )
  useDOMEvent('window', LOCAL_MODEL_SETTINGS_CHANGED_EVENT, store.invalidateNative, {
    enabled: active,
  })
  const refresh = () => {
    if (active) store.refresh()
  }
  const readyCatalog = services?.standInApi && deviceId ? catalog : null
  const entries = useMemo(
    () => [
      ...(active && readyCatalog?.native.valid ? readyCatalog.native.entries : []),
      ...(active && readyCatalog?.cloud.valid ? readyCatalog.cloud.entries : []),
    ],
    [active, readyCatalog]
  )
  // Cloud entries never supply an implicit default.
  const defaults = entries.filter(entry => entry.isDefault)
  const defaultIdentity = defaults.length === 1 ? defaults[0].identity : null
  const identity = draft.model ?? defaultIdentity
  const selectedEntry = useMemo(
    () =>
      identity
        ? entries.find(entry => runnerModelKey(entry.identity) === runnerModelKey(identity))
        : undefined,
    [identity, entries]
  )
  const models = useMemo(
    () =>
      [...(readyCatalog?.native.entries ?? []), ...(readyCatalog?.cloud.entries ?? [])].map(
        entry => entry.model
      ),
    [readyCatalog]
  )
  const selectedModel = useMemo(
    () =>
      identity
        ? (selectedEntry?.model ?? {
            name: identity.model_id,
            type: 'runtime' as const,
            displayName: identity.model_id,
            modelId: identity.model_id,
            runtime: { family: identity.runtime },
          })
        : null,
    [identity, selectedEntry]
  )
  const resolve = (model: UnifiedModel | null) =>
    model
      ? (entries.find(entry => isSameModelSelection(entry.model, model))?.identity ?? null)
      : null
  const isLoadingModel = (model: UnifiedModel | null) => {
    if (!active) return true
    if (model && resolve(model)) return false
    const source =
      model === selectedModel
        ? identity?.source === 'cloud'
          ? 'cloud'
          : 'native'
        : model?.type === 'runtime'
          ? 'native'
          : 'cloud'
    const state = readyCatalog?.[source]
    return Boolean(
      services?.standInApi &&
      deviceId &&
      (!state || state.pending || (!state.valid && !state.error))
    )
  }
  const errors = {
    native: readyCatalog?.native.error ?? null,
    cloud: readyCatalog?.cloud.error ?? null,
  }
  return {
    refresh,
    loading: isLoadingModel(selectedModel),
    isLoadingModel,
    models,
    selectedModel,
    defaultIdentity,
    errors,
    error: [...new Set([errors.native, errors.cloud].filter(Boolean))].join('\n') || null,
    unavailable: Boolean(identity && readyCatalog && !selectedEntry),
    resolve,
    getModelOptionId: (model: UnifiedModel) => {
      const identity = resolve(model)
      return identity ? runnerModelKey(identity) : model.name
    },
  }
}
