import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  createUnlistedStandInTasksSource,
  isStandInNotificationTask,
  type UnlistedTaskCandidate,
} from './unlistedStandInTasksSource'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'

const projectedItems = new WeakMap<RuntimeTaskReminderItem, RuntimeTaskReminderItem>()

function withLifecycle(
  item: RuntimeTaskReminderItem,
  lifecycle: RuntimeTaskReminderItem['lifecycle']
): RuntimeTaskReminderItem {
  if (item.lifecycle === lifecycle) return item
  const previous = projectedItems.get(item)
  if (previous && previous.lifecycle === lifecycle) return previous
  const projected = { ...item, lifecycle }
  projectedItems.set(item, projected)
  return projected
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
  const visible = useMemo(() => new Set(items.map(item => item.key)), [items])
  const pending = useMemo(() => {
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

  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, pending),
    [source, pending]
  )
  const loaded = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)

  return useMemo(() => {
    let next: RuntimeTaskReminderItem[] | undefined
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const projected = withLifecycle(item, snapshot.tasks.get(item.key))
      if (item === projected) continue
      next ??= items.slice()
      next[index] = projected
    }
    for (const item of loaded.values()) {
      if (visible.has(item.key)) continue
      const lifecycle = snapshot.tasks.get(item.key)
      if (!lifecycle) continue
      next ??= items.slice()
      next.push(withLifecycle(item, lifecycle))
    }
    return next ?? items
  }, [items, loaded, snapshot.tasks, visible])
}
