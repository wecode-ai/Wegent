import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  createUnlistedStandInTasksSource,
  isStandInNotificationTask,
} from './unlistedStandInTasksSource'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'

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
    return [...snapshot.tasks.values()]
      .filter(task => !visible.has(task.key) && needsStandInLookup(task.task))
      .map(task => ({
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
      }))
  }, [visible, snapshot.tasks])

  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, pending),
    [source, pending]
  )
  const loaded = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)

  return useMemo(() => {
    let next: RuntimeTaskReminderItem[] | undefined
    for (const [index, item] of items.entries()) {
      const lifecycle = snapshot.tasks.get(item.key)
      if (lifecycle === item.lifecycle) continue
      next ??= items.slice()
      next[index] = { ...item, lifecycle }
    }
    for (const item of loaded.values()) {
      if (visible.has(item.key)) continue
      const lifecycle = snapshot.tasks.get(item.key)
      if (!lifecycle) continue
      next ??= items.slice()
      next.push({ ...item, lifecycle })
    }
    return next ?? items
  }, [items, loaded, snapshot.tasks, visible])
}
