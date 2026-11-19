import { useCallback, useMemo, useState, useSyncExternalStore, type SetStateAction } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type {
  ProjectCreateGenerationModel,
  ProjectCreateGenerationModelCatalog,
  ProjectCreateGenerationModelSelection,
} from './types'

export function generationModelKey(model: { modelName: string; modelType?: string | null }) {
  return `${model.modelType ?? ''}:${model.modelName}`
}

const EMPTY_MODELS: ProjectCreateGenerationModel[] = []

function resolveSelection(
  catalog: ProjectCreateGenerationModelCatalog,
  key: string,
  options: Record<string, string>
) {
  const previous = catalog.models.find(model => generationModelKey(model) === key)
  const saved = catalog.defaultSelection
  const preferred = saved
    ? catalog.models.find(model => generationModelKey(model) === generationModelKey(saved))
    : undefined
  const selected = previous ?? preferred ?? catalog.models[0]
  return {
    key: selected ? generationModelKey(selected) : '',
    options: previous
      ? options
      : { ...selected?.options, ...(preferred ? saved?.options : undefined) },
  }
}

/** Keep model discovery local to the active configuration step. */
export function useProjectGenerationModels(
  active: boolean,
  loader: (() => Promise<ProjectCreateGenerationModelCatalog>) | undefined,
  formatError: ((cause: unknown) => string) | undefined,
  failedLabel: string
) {
  const resource = useMemo(
    () => (loader ? createAsyncResource('project-generation-models', () => loader()) : null),
    [loader]
  )
  const [activation, setActivation] = useState(() => ({
    resource,
    requested: active && resource !== null,
  }))
  if (activation.resource !== resource || (active && resource !== null && !activation.requested)) {
    setActivation({ resource, requested: active && resource !== null })
  }
  const snapshot = useSyncExternalStore(
    activation.requested && resource ? resource.subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const catalog = snapshot.data
  const [selection, setSelection] = useState(() => ({
    resource,
    catalog: undefined as ProjectCreateGenerationModelCatalog | undefined,
    key: '',
    options: {} as Record<string, string>,
  }))
  if (selection.resource !== resource) {
    setSelection({ resource, catalog: undefined, key: '', options: {} })
  } else if (catalog && selection.catalog !== catalog) {
    setSelection({
      resource,
      catalog,
      ...resolveSelection(catalog, selection.key, selection.options),
    })
  }
  const models = catalog?.models ?? EMPTY_MODELS
  const reload = useCallback(async () => {
    await resource?.reload()
  }, [resource])
  const selectModel = (
    value: ProjectCreateGenerationModelSelection,
    options?: Record<string, string>
  ) => {
    const model = models.find(
      candidate => generationModelKey(candidate) === generationModelKey(value)
    )
    if (!model) return false
    setSelection(current => ({
      ...current,
      key: generationModelKey(model),
      options: { ...model.options, ...options },
    }))
    return true
  }
  const setOptions = (options: SetStateAction<Record<string, string>>) =>
    setSelection(current => ({
      ...current,
      options: typeof options === 'function' ? options(current.options) : options,
    }))
  const error =
    snapshot.status === 'error'
      ? (formatError?.(snapshot.error) ??
        (snapshot.error instanceof Error ? snapshot.error.message : failedLabel))
      : null
  return {
    models,
    key: selection.key,
    options: selection.options,
    loading: Boolean(
      activation.requested &&
      resource &&
      (snapshot.status === 'idle' || snapshot.status === 'loading')
    ),
    error,
    reload,
    selectModel,
    setOptions,
  }
}
