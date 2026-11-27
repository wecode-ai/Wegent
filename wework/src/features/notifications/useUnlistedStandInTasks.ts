import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { dequal } from 'dequal'
import {
  createUnlistedStandInTasksSource,
  isStandInNotificationTask,
  type UnlistedTaskCandidate,
} from './unlistedStandInTasksSource'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'

function createReminderProjection() {
  // Cache immutable rows by both inputs so an interrupted render cannot replace another pair.
  const projected = new WeakMap<RuntimeTaskReminderItem, WeakMap<object, RuntimeTaskReminderItem>>()
  const missingLifecycle = {}
  let previousRows: RuntimeTaskReminderItem[] | undefined
  const projectRow = (
    item: RuntimeTaskReminderItem,
    lifecycle: RuntimeTaskReminderItem['lifecycle']
  ) => {
    if (item.lifecycle === lifecycle) return item
    let byLifecycle = projected.get(item)
    if (!byLifecycle) {
      byLifecycle = new WeakMap()
      projected.set(item, byLifecycle)
    }
    const key = lifecycle ?? missingLifecycle
    const cached = byLifecycle.get(key)
    if (cached) return cached
    const next = { ...item, lifecycle }
    byLifecycle.set(key, next)
    return next
  }
  return (
    items: RuntimeTaskReminderItem[],
    loaded: ReadonlyMap<string, RuntimeTaskReminderItem>,
    tasks: RuntimeTaskLifecycleStoreSnapshot['tasks'],
    visible: ReadonlySet<string>
  ) => {
    let next: RuntimeTaskReminderItem[] | undefined
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const row = projectRow(item, tasks.get(item.key))
      if (row === item) continue
      next ??= items.slice()
      next[index] = row
    }
    for (const item of loaded.values()) {
      if (visible.has(item.key)) continue
      const lifecycle = tasks.get(item.key)
      if (!lifecycle) continue
      next ??= items.slice()
      next.push(projectRow(item, lifecycle))
    }
    const rows = next ?? items
    const previous = previousRows
    if (
      previous &&
      previous.length === rows.length &&
      rows.every((row, index) => row === previous[index])
    )
      return previous
    previousRows = rows
    return rows
  }
}

function needsStandInLookup(task: RuntimeTaskReminderItem['task'] | null): boolean {
  const handle = task?.runtimeHandle
  // Native task summaries preserve the origin used by readTask.
  if (
    !task ||
    task.cachedProjection ||
    task.optimistic ||
    !handle ||
    !Object.hasOwn(handle, 'threadId')
  )
    return true
  return isStandInNotificationTask(task)
}

/** Sidebar project filters must not hide executions from collaboration notifications. */
export function useUnlistedStandInTasks(
  items: RuntimeTaskReminderItem[],
  snapshot: RuntimeTaskLifecycleStoreSnapshot,
  reader?: Pick<StandInExecutorApi, 'readTask'>
): RuntimeTaskReminderItem[] {
  const source = useMemo(() => createUnlistedStandInTasksSource(reader), [reader])
  const projection = useMemo(() => createReminderProjection(), [])
  const visible = useMemo(() => new Set(items.map(item => item.key)), [items])
  const candidates = useMemo(() => {
    const candidates: UnlistedTaskCandidate[] = []
    for (const task of snapshot.tasks.values()) {
      if (visible.has(task.key) || !needsStandInLookup(task.task)) continue
      candidates.push({
        key: task.key,
        address: task.address,
        signature: JSON.stringify([
          task.execution.phase,
          task.turn.id,
          task.turn.latestId,
          task.turn.outcome,
          task.interactionStatus,
          task.task?.updatedAt,
        ]),
      })
    }
    return candidates
  }, [visible, snapshot.tasks])
  // Keep the subscription's inputs with React state so an abandoned render cannot change them.
  const [pending, setPending] = useState(candidates)
  if (!dequal(pending, candidates)) setPending(candidates)

  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, pending),
    [source, pending]
  )
  const loaded = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)

  return useMemo(
    () => projection(items, loaded, snapshot.tasks, visible),
    [projection, items, loaded, snapshot.tasks, visible]
  )
}
