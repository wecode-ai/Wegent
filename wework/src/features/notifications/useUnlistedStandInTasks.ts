import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createUnlistedStandInTasksSource } from './unlistedStandInTasksSource'
import type { StandInExecutorApi } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type {
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'

const rowsWithLifecycle = new WeakMap<RuntimeTaskReminderItem, RuntimeTaskReminderItem>()

function withLifecycle(
  item: RuntimeTaskReminderItem,
  lifecycle: RuntimeTaskLifecycleSnapshot | undefined
): RuntimeTaskReminderItem {
  if (item.lifecycle === lifecycle) return item
  const cached = rowsWithLifecycle.get(item)
  if (cached && cached.lifecycle === lifecycle) return cached
  const row = { ...item, lifecycle }
  rowsWithLifecycle.set(item, row)
  return row
}

/** Sidebar project filters must not hide executions from collaboration notifications. */
export function useUnlistedStandInTasks(
  items: RuntimeTaskReminderItem[],
  snapshot: RuntimeTaskLifecycleStoreSnapshot,
  reader?: StandInExecutorApi
): RuntimeTaskReminderItem[] {
  const source = useMemo(() => createUnlistedStandInTasksSource(reader), [reader])
  const visible = useMemo(() => new Set(items.map(item => item.key)), [items])
  const pending = useMemo(() => {
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
  }, [visible, snapshot.tasks])

  const subscribe = useCallback(
    (notify: () => void) => source.subscribe(notify, pending),
    [source, pending]
  )
  const loaded = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)

  return useMemo(() => {
    let next: RuntimeTaskReminderItem[] | undefined
    for (const [index, item] of items.entries()) {
      const row = withLifecycle(item, snapshot.tasks.get(item.key))
      if (row === item) continue
      next ??= items.slice()
      next[index] = row
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
