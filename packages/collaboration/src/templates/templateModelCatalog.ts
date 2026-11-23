import { createAsyncResource } from '@wegent/chat-core/async-resource'
import {
  runnerModelKey,
  type RunnerModel,
  type RunnerModelIdentity,
} from '../agent-form/runnerRouting'
import type { TemplateModelConfiguration } from './TemplateModelSelection'

/** One mounted model picker owns both catalogs and its explicit selection. */
export function createTemplateModelCatalog(
  runtime: RunnerModelIdentity['runtime'],
  { host, projectId, environmentId, location }: TemplateModelConfiguration
) {
  const native = createAsyncResource('template-native-models', () =>
    environmentId
      ? host.listTemplateAgentModels!(runtime, {
          projectId,
          environmentId,
          location,
        })
      : Promise.resolve({ models: [] as RunnerModel[] })
  )
  const cloud = createAsyncResource(
    'template-cloud-models',
    () => host.listTemplateCloudAgentModels?.(runtime, projectId) ?? Promise.resolve([])
  )
  type Observer = {
    notify(): void
    change(model: RunnerModelIdentity | undefined): void
  }
  const observers = new Set<Observer>()
  let selected = ''
  let chosen = false
  let stop: (() => void) | undefined
  let reported = false
  let lastReported: RunnerModel | undefined
  const read = () => {
    const state = native.getSnapshot()
    const remote = cloud.getSnapshot()
    const loading = state.status === 'idle' || state.status === 'loading'
    const cloudLoading = remote.status === 'idle' || remote.status === 'loading'
    const error = !loading && state.error !== undefined
    const cloudUnavailable = !cloudLoading && remote.error !== undefined
    const catalog = [
      ...new Map(
        [...(remote.data ?? []), ...(environmentId ? (state.data?.models ?? []) : [])].map(
          model => [runnerModelKey(model), model]
        )
      ).values(),
    ]
    if (!loading && !error) {
      const defaults = catalog.filter(model => model.is_default)
      const initial =
        catalog.find(model => runnerModelKey(model) === selected) ??
        (!chosen && defaults.length === 1 ? defaults[0] : undefined)
      if (initial) chosen = true
      selected = initial ? runnerModelKey(initial) : ''
    }
    const model =
      loading || error
        ? undefined
        : catalog.find(
            model =>
              runnerModelKey(model) === selected &&
              !(model.source === 'cloud' && (cloudLoading || cloudUnavailable))
          )
    return {
      catalog,
      selected,
      model,
      loading,
      cloudLoading,
      error,
      cloudUnavailable,
    }
  }
  let snapshot = read()
  const publish = () => {
    snapshot = read()
    const changed = !reported || lastReported !== snapshot.model
    reported = true
    lastReported = snapshot.model
    for (const observer of observers) {
      observer.notify()
      if (changed) observer.change(snapshot.model)
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void, change: Observer['change']) {
      const observer = { notify, change }
      observers.add(observer)
      if (!stop) {
        const stopNative = native.subscribe(publish)
        const stopCloud = cloud.subscribe(publish)
        stop = () => {
          stopNative()
          stopCloud()
        }
        publish()
      }
      return () => {
        observers.delete(observer)
        // A callback replacement transfers the live catalogs to the new observer.
        queueMicrotask(() => {
          if (observers.size) return
          stop?.()
          stop = undefined
          reported = false
        })
      }
    },
    select(key: string) {
      selected = key
      chosen = true
      publish()
    },
    refresh() {
      void native.reload()
      void cloud.reload()
    },
  }
}
