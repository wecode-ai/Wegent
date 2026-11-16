import { useEffect } from 'react'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  replyPredictionKey,
  replyPredictionService,
  runtimeReplyPredictionSource,
} from './replyPredictionService'

// Live outside task Activities: hiding a composer must not cancel its prediction.
export function ReplyPredictionCoordinator({
  services,
  store,
}: {
  services: WorkbenchServices
  store: RuntimeTaskLifecycleStore
}) {
  const preferences = useAppPreferencesState()
  const enabled = preferences?.loaded && preferences.preferences.replyPredictionsEnabled
  const api = services.replyPredictionApi
  useEffect(() => {
    if (!enabled || !api) return
    const service = replyPredictionService(api)
    const owners = new Map<string, { scope: string; release: () => void }>()
    const observedActivity = new Set<string>()
    const requested = new Map<string, string>()
    let previous = store.getSnapshot()
    const synchronize = () => {
      const snapshot = store.getSnapshot()
      for (const key of previous.tasks.keys()) {
        if (snapshot.tasks.has(key)) continue
        owners.get(key)?.release()
        owners.delete(key)
        observedActivity.delete(key)
        requested.delete(key)
      }
      for (const [key, task] of snapshot.tasks) {
        const prior = previous.tasks.get(key)
        if (task.derived.isBusy || (prior && prior.turn.latestId !== task.turn.latestId)) {
          observedActivity.add(key)
        }
        const source = runtimeReplyPredictionSource(task.address, task)
        if (!source) continue
        const owner = owners.get(key)
        if (owner?.scope !== source.scope) {
          owner?.release()
          owners.set(key, { scope: source.scope, release: service.retain(source.scope) })
        }
        if (source.busy) {
          service.invalidate(source.scope)
          requested.delete(key)
          continue
        }
        // Do not generate a backlog for every historical task on window startup.
        if (!observedActivity.has(key)) continue
        const predictionKey = replyPredictionKey(source)
        if (requested.get(key) === predictionKey) continue
        requested.set(key, predictionKey)
        void service.request(source)
      }
      previous = snapshot
    }
    const unsubscribe = store.subscribe(synchronize)
    synchronize()
    return () => {
      unsubscribe()
      for (const owner of owners.values()) owner.release()
    }
  }, [enabled, api, store])
  return null
}
