import type { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'
import {
  replyPredictionKey,
  runtimeReplyPredictionSource,
  type ReplyPredictionResult,
  type ReplyPredictionService,
  type ReplyPredictionSource,
} from './replyPredictionService'

export interface ReplyPredictionFeedEntry {
  key: string
  busy: boolean
  requested: boolean
  prediction: ReplyPredictionResult | null
  pending: boolean
}

export interface ReplyPredictionFeedSnapshot {
  service: ReplyPredictionService
  entries: ReadonlyMap<string, ReplyPredictionFeedEntry>
  accept(scope: string, key: string): void
}

/** The window feed owns background scopes and publishes the candidates consumed by composers. */
export function createReplyPredictionFeed(
  service: ReplyPredictionService,
  store: RuntimeTaskLifecycleStore
) {
  const listeners = new Set<() => void>()
  const owners = new Map<string, { scope: string; release(): void }>()
  const observedActivity = new Set<string>()
  const tasks = new Map<
    string,
    {
      source: ReplyPredictionSource
      key: string
      requested: boolean
      prediction: ReplyPredictionResult | null
    }
  >()
  let initialized = false
  let stopStore: (() => void) | undefined
  let stopService: (() => void) | undefined
  let synchronizing = false
  const accept = (scope: string, key: string) => {
    const entry = snapshot.entries.get(scope)
    if (
      !listeners.size ||
      !entry ||
      entry.key !== key ||
      entry.busy ||
      !entry.prediction?.isCurrent()
    )
      return
    entry.prediction.onAccept()
    publish()
  }
  let snapshot: ReplyPredictionFeedSnapshot = { service, entries: new Map(), accept }
  function suspend(error: unknown) {
    tasks.clear()
    observedActivity.clear()
    for (const owner of owners.values()) owner.release()
    owners.clear()
    initialized = false
    snapshot = { service, entries: new Map(), accept }
    listeners.forEach(listener => listener())
    reportReplyPredictionFeedError(error)
  }
  function publish() {
    if (synchronizing) return
    try {
      const entries = new Map<string, ReplyPredictionFeedEntry>()
      const pendingScopes = service.getPendingScopes()
      let changed = false
      for (const task of tasks.values()) {
        const prediction = task.prediction?.isCurrent() ? task.prediction : null
        const pending = !task.source.busy && pendingScopes.has(task.source.scope)
        const prior = snapshot.entries.get(task.source.scope)
        const entry: ReplyPredictionFeedEntry = {
          key: task.key,
          busy: task.source.busy,
          requested: task.requested,
          prediction,
          pending,
        }
        if (
          prior &&
          prior.key === entry.key &&
          prior.busy === entry.busy &&
          prior.requested === entry.requested &&
          prior.prediction === entry.prediction &&
          prior.pending === entry.pending
        ) {
          entries.set(task.source.scope, prior)
        } else {
          entries.set(task.source.scope, entry)
          changed = true
        }
      }
      if (!changed && snapshot.entries.size === entries.size) return
      snapshot = { service, entries, accept }
      listeners.forEach(listener => listener())
    } catch (error) {
      suspend(error)
    }
  }
  const synchronize: Parameters<RuntimeTaskLifecycleStore['subscribeTaskChanges']>[0] = (
    changedKeys,
    before,
    after
  ) => {
    synchronizing = true
    let synchronized = false
    try {
      const keys = initialized ? changedKeys : after.keys()
      for (const key of keys) {
        const task = after.get(key)
        const prior = before.get(key)
        if (task && (task.derived.isBusy || (prior && prior.turn.latestId !== task.turn.latestId)))
          observedActivity.add(key)
        const source = task && runtimeReplyPredictionSource(task.address, task)
        const owner = owners.get(key)
        if (!source) {
          if (tasks.delete(key)) synchronized = true
          owner?.release()
          owners.delete(key)
          observedActivity.delete(key)
          continue
        }
        if (owner?.scope !== source.scope) {
          owner?.release()
          owners.set(key, { scope: source.scope, release: service.retain(source.scope) })
        }
        const predictionKey = replyPredictionKey(source)
        let current = tasks.get(key)
        if (!current || current.key !== predictionKey || current.source.busy !== source.busy) {
          current = { source, key: predictionKey, requested: false, prediction: null }
          tasks.set(key, current)
          synchronized = true
          if (source.busy) service.invalidate(source.scope)
        }
        // A historical task retains its scope but starts no backlog request.
        if (source.busy || !observedActivity.has(key) || current.requested) continue
        current.requested = true
        synchronized = true
        const request = current
        void service.request(source).then(
          prediction => {
            if (tasks.get(key) !== request || !listeners.size) return
            request.prediction = prediction
            publish()
          },
          () => {
            if (tasks.get(key) !== request || !listeners.size) return
            request.prediction = null
            publish()
          }
        )
      }
      initialized = true
    } catch (error) {
      suspend(error)
    } finally {
      synchronizing = false
      if (synchronized) publish()
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        try {
          const { tasks: currentTasks } = store.getSnapshot()
          stopService = service.subscribe(publish)
          stopStore = store.subscribeTaskChanges(synchronize)
          synchronize(new Set(), currentTasks, currentTasks)
        } catch (error) {
          stopStore?.()
          stopStore = undefined
          stopService?.()
          stopService = undefined
          suspend(error)
        }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        stopStore?.()
        stopStore = undefined
        stopService?.()
        stopService = undefined
        for (const owner of owners.values()) owner.release()
        owners.clear()
        observedActivity.clear()
        tasks.clear()
        initialized = false
        snapshot = { service, entries: new Map(), accept }
      }
    },
  }
}

export function reportReplyPredictionFeedError(error: unknown) {
  console.debug('[Wework] Reply prediction feed unavailable', {
    reason: error instanceof Error ? error.name : 'unknown',
  })
}
