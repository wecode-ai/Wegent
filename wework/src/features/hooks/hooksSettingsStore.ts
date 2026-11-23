import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { subscribeLocalExecutorEvents } from '@/desktop/localExecutor'
import { hooksApi } from './hooksApi'
import type { HookRunSummary, ResolvedHookPlugin } from './hooksTypes'

/** One settings reader owns its list revisions and executor event connection. */
export function createHooksSettingsStore() {
  const completedRuns = new Map<string, HookRunSummary>()
  const mergeRuns = (items: ResolvedHookPlugin[]) =>
    items.map(plugin => {
      const runs = new Map(plugin.recentRuns.map(run => [run.handlerId, run]))
      for (const run of completedRuns.values()) {
        if (run.pluginId !== plugin.manifest.id) continue
        if ((runs.get(run.handlerId)?.startedAtMs ?? -1) <= run.startedAtMs)
          runs.set(run.handlerId, run)
      }
      return {
        ...plugin,
        recentRuns: [...runs.values()].sort((a, b) => b.startedAtMs - a.startedAtMs),
      }
    })
  const resource = createAsyncResource<ResolvedHookPlugin[]>(
    'hooks',
    async () => mergeRuns(await hooksApi.list()),
    { refreshOnSubscribe: true }
  )
  let subscribers = 0
  let disconnect: (() => void) | undefined
  const update = (change: (items: ResolvedHookPlugin[]) => ResolvedHookPlugin[]) =>
    resource.update(items => change(items ?? []))
  const connect = () => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribeLocalExecutorEvents(message => {
      if (disposed) return
      if (message.event === 'runtime.hooks.changed') void resource.reload()
      else if (message.event === 'runtime.hooks.run_completed') {
        const run = message.payload.run as HookRunSummary
        completedRuns.set(JSON.stringify([run.pluginId, run.handlerId]), run)
        const snapshot = resource.getSnapshot()
        if (snapshot.data) {
          update(mergeRuns)
          if (snapshot.status === 'loading') void resource.reload()
        }
      }
    }).then(value => {
      if (disposed) value()
      else unsubscribe = value
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }
  return {
    ...resource,
    update,
    subscribe(listener: () => void) {
      subscribers++
      const stop = resource.subscribe(listener)
      if (subscribers === 1) disconnect = connect()
      return () => {
        stop()
        if (--subscribers === 0) {
          disconnect?.()
          disconnect = undefined
        }
      }
    },
  }
}
