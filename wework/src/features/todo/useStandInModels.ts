import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/** Model references remain device-scoped; credentials are resolved by the Executor. */
export function useStandInModels(
  services: WorkbenchServices | undefined,
  draft: WorkspaceStandInSettings,
  runtime: RunnerModelIdentity['runtime'] = draft.model?.runtime ?? 'codex',
  active = true
) {
  const deviceId = draft.executionDeviceId
  const scope = useMemo(() => ({ services, deviceId, runtime }), [services, deviceId, runtime])
  const [catalog, setCatalog] = useState<{
    scope: object
    native: SourceState
    cloud: SourceState
  } | null>(null)
  const revisions = useRef({ native: 0, cloud: 0 })
  const loadSource = useCallback(
    async (source: CatalogSource, read: () => Promise<CatalogResult>, invalidate = false) => {
      if (!active || !services?.standInApi || !deviceId) return
      const revision = ++revisions.current[source]
      setCatalog(current => {
        const value =
          current?.scope === scope
            ? current
            : { scope, native: emptySource(), cloud: emptySource() }
        return {
          ...value,
          [source]: { ...(invalidate ? emptySource() : value[source]), pending: true, error: null },
        }
      })
      let result: CatalogResult
      try {
        result = await read()
      } catch (error) {
        result = { entries: [], error }
      }
      if (revision !== revisions.current[source]) return
      setCatalog(current =>
        current?.scope === scope
          ? { ...current, [source]: publishedSource(current[source], result) }
          : current
      )
    },
    [active, services, deviceId, scope]
  )
  const loadCatalog = useCallback(
    (invalidateNative = false, forceRefresh = false) => {
      if (!active || !services?.standInApi || !deviceId) return
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
      void loadSource('cloud', async () => ({
        entries: runnerModelCatalog(
          [],
          (await services.modelApi.listModels(forceRefresh ? { forceRefresh: true } : undefined))
            .data,
          runtime
        ),
      }))
    },
    [active, services, deviceId, runtime, loadSource]
  )
  const refresh = useCallback(() => {
    if (!active || !services?.standInApi || !deviceId) return
    services?.modelApi.refresh?.()
    loadCatalog(false, true)
  }, [active, services, deviceId, loadCatalog])
  useEffect(() => {
    if (!active || !services?.standInApi || !deviceId) return
    let cancelled = false
    const requestRevisions = revisions.current
    const reload = () => loadCatalog()
    const invalidateNative = () => loadCatalog(true)
    const unsubscribe = services.modelApi.subscribe?.(reload)
    window.addEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, invalidateNative)
    queueMicrotask(() => {
      if (!cancelled) loadCatalog()
    })
    return () => {
      cancelled = true
      requestRevisions.native += 1
      requestRevisions.cloud += 1
      unsubscribe?.()
      window.removeEventListener(LOCAL_MODEL_SETTINGS_CHANGED_EVENT, invalidateNative)
      // Keep display data while hidden, but revalidate identities before sending again.
      setCatalog(current =>
        current?.scope === scope
          ? {
              ...current,
              native: { ...current.native, valid: false, pending: false },
              cloud: { ...current.cloud, valid: false, pending: false },
            }
          : current
      )
    }
  }, [active, services, deviceId, loadCatalog, scope])
  const readyCatalog = catalog?.scope === scope ? catalog : null
  const entries = useMemo(
    () => [
      ...(readyCatalog?.native.valid ? readyCatalog.native.entries : []),
      ...(readyCatalog?.cloud.valid ? readyCatalog.cloud.entries : []),
    ],
    [readyCatalog]
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
