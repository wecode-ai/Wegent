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

interface PredictionTask {
  source: ReplyPredictionSource
  key: string
  requested: boolean
  prediction: ReplyPredictionResult | null
}

/** The window feed owns background scopes and publishes the candidates consumed by composers. */
export function createReplyPredictionFeed(
  service: ReplyPredictionService,
  store: RuntimeTaskLifecycleStore
) {
  const listeners = new Set<() => void>()
  const owners = new Map<string, { scope: string; release(): void }>()
  const observedActivity = new Set<string>()
  const tasks = new Map<string, PredictionTask>()
  const changedScopes = new Set<string>()
  let refreshAll = false
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
    updateScope(scope)
  }
  let snapshot: ReplyPredictionFeedSnapshot = { service, entries: new Map(), accept }
  function suspend(error: unknown) {
    tasks.clear()
    changedScopes.clear()
    refreshAll = false
    observedActivity.clear()
    for (const owner of owners.values()) owner.release()
    owners.clear()
    initialized = false
    snapshot = { service, entries: new Map(), accept }
    listeners.forEach(listener => listener())
    reportReplyPredictionFeedError(error)
  }
  function updateScope(scope?: string) {
    if (scope === undefined) refreshAll = true
    else changedScopes.add(scope)
    publish()
  }
  function publish() {
    if (synchronizing || (!refreshAll && !changedScopes.size)) return
    try {
      let entries: Map<string, ReplyPredictionFeedEntry> | undefined
      const pendingScopes = service.getPendingScopes()
      const scopes = refreshAll
        ? new Set([...snapshot.entries.keys(), ...tasks.keys()])
        : changedScopes
      for (const scope of scopes) {
        const task = tasks.get(scope)
        const prior = (entries ?? snapshot.entries).get(scope)
        if (!task) {
          if (prior) (entries ??= new Map(snapshot.entries)).delete(scope)
          continue
        }
        const prediction = task.prediction?.isCurrent() ? task.prediction : null
        const pending = !task.source.busy && pendingScopes.has(scope)
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
        )
          continue
        entries ??= new Map(snapshot.entries)
        entries.set(scope, entry)
      }
      refreshAll = false
      changedScopes.clear()
      if (!entries) return
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
    try {
      const keys = initialized ? changedKeys : after.keys()
      for (const key of keys) {
        const task = after.get(key)
        const prior = before.get(key)
        if (task && (task.derived.isBusy || (prior && prior.turn.latestId !== task.turn.latestId)))
          observedActivity.add(key)
        const source = task && runtimeReplyPredictionSource(task.address, task)
        const owner = owners.get(key)
        if (owner && owner.scope !== source?.scope) {
          owner.release()
          tasks.delete(owner.scope)
          changedScopes.add(owner.scope)
          owners.delete(key)
        }
        if (!source) {
          observedActivity.delete(key)
          continue
        }
        if (owner?.scope !== source.scope) {
          owners.set(key, { scope: source.scope, release: service.retain(source.scope) })
        }
        const predictionKey = replyPredictionKey(source)
        let current = tasks.get(source.scope)
        if (!current || current.key !== predictionKey || current.source.busy !== source.busy) {
          current = { source, key: predictionKey, requested: false, prediction: null }
          tasks.set(source.scope, current)
          changedScopes.add(source.scope)
          if (source.busy) service.invalidate(source.scope)
        }
        // A historical task retains its scope but starts no backlog request.
        if (source.busy || !observedActivity.has(key) || current.requested) continue
        current.requested = true
        changedScopes.add(source.scope)
        const request = current
        void service.request(source).then(
          prediction => {
            if (tasks.get(source.scope) !== request || !listeners.size) return
            request.prediction = prediction
            updateScope(source.scope)
          },
          () => {
            if (tasks.get(source.scope) !== request || !listeners.size) return
            request.prediction = null
            updateScope(source.scope)
          }
        )
      }
      initialized = true
    } catch (error) {
      suspend(error)
    } finally {
      synchronizing = false
      publish()
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        try {
          const { tasks: currentTasks } = store.getSnapshot()
          stopService = service.subscribe(updateScope)
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
        changedScopes.clear()
        refreshAll = false
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
