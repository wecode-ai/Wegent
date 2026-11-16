import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import type { ProjectCreateGenerationModel, ProjectCreateGenerationModelCatalog } from './types'

export function generationModelKey(model: { modelName: string; modelType?: string | null }) {
  return `${model.modelType ?? ''}:${model.modelName}`
}

type ModelState = {
  models: ProjectCreateGenerationModel[]
  key: string
  options: Record<string, string>
  loading: boolean
  error: string | null
}

/** Keep model discovery local to the active configuration step. */
export function useProjectGenerationModels(
  active: boolean,
  loader: (() => Promise<ProjectCreateGenerationModelCatalog>) | undefined,
  formatError: ((cause: unknown) => string) | undefined,
  failedLabel: string
) {
  const inputs = useRef({ loader, formatError, failedLabel })
  const requested = useRef(false)
  const version = useRef(0)
  const [state, setState] = useState<ModelState>({
    models: [],
    key: '',
    options: {},
    loading: false,
    error: null,
  })
  useEffect(() => {
    inputs.current = { loader, formatError, failedLabel }
  }, [loader, formatError, failedLabel])
  useEffect(
    () => () => {
      version.current += 1
      requested.current = false
    },
    []
  )
  const reload = useCallback(async () => {
    const { loader, formatError, failedLabel } = inputs.current
    if (!loader) return
    requested.current = true
    const request = ++version.current
    setState(current => ({ ...current, loading: true, error: null }))
    try {
      const catalog = await loader()
      if (request !== version.current) return
      setState(current => {
        const previous = catalog.models.find(model => generationModelKey(model) === current.key)
        const preferred = catalog.defaultSelection
          ? catalog.models.find(
              model => generationModelKey(model) === generationModelKey(catalog.defaultSelection!)
            )
          : undefined
        const selected = previous ?? preferred ?? catalog.models[0]
        return {
          models: catalog.models,
          key: selected ? generationModelKey(selected) : '',
          options: previous ? current.options : (selected?.options ?? {}),
          loading: false,
          error: null,
        }
      })
    } catch (cause) {
      if (request !== version.current) return
      setState(current => ({
        ...current,
        loading: false,
        error: formatError?.(cause) ?? (cause instanceof Error ? cause.message : failedLabel),
      }))
    }
  }, [])
  useEffect(() => {
    if (active && loader && !requested.current) void reload()
  }, [active, loader, reload])
  const setKey = (key: string) => setState(current => ({ ...current, key }))
  const setOptions = (options: SetStateAction<Record<string, string>>) =>
    setState(current => ({
      ...current,
      options: typeof options === 'function' ? options(current.options) : options,
    }))
  return { ...state, reload, setKey, setOptions }
}
