import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createUnlistedStandInTasksSource } from './unlistedStandInTasksSource'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'

/** Sidebar project filters must not hide executions from collaboration notifications. */
export function useUnlistedStandInTasks(
  items: RuntimeTaskReminderItem[],
  snapshot: RuntimeTaskLifecycleStoreSnapshot,
  reader?: StandInExecutorApi,
  runtimeApi?: WorkbenchServices['runtimeWorkApi']
): RuntimeTaskReminderItem[] {
  const source = useMemo(
    () => createUnlistedStandInTasksSource(reader, runtimeApi),
    [reader, runtimeApi]
  )
  const pending = useMemo(() => {
    const visible = new Set(items.map(item => item.key))
    return [...snapshot.tasks.values()]
      .filter(task => !visible.has(task.key))
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
  }, [items, snapshot.tasks])

  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, pending),
    [source, pending]
  )
  const loaded = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)

  return useMemo(() => {
    const visible = new Set(items.map(item => item.key))
    return [
      ...items,
      ...[...loaded.values()].filter(
        item => !visible.has(item.key) && snapshot.tasks.has(item.key)
      ),
    ].map(item => ({ ...item, lifecycle: snapshot.tasks.get(item.key) }))
  }, [items, loaded, snapshot.tasks])
}
