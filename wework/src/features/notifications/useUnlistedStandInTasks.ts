import { useEffect, useMemo, useRef, useState } from 'react'
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
) {
  const [loaded, setLoaded] = useState<Map<string, RuntimeTaskReminderItem>>(new Map())
  const attempted = useRef(new Map<string, string>())
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
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

  useEffect(() => {
    if (!reader || !runtimeApi) return
    for (const candidate of pending) {
      if (attempted.current.get(candidate.key) === candidate.signature) continue
      attempted.current.set(candidate.key, candidate.signature)
      void (async () => {
        const result = await reader.readTask(candidate.address.deviceId, candidate.address.taskId)
        if (!result.success || !result.task) {
          if (mounted.current)
            setLoaded(current => {
              const next = new Map(current)
              next.delete(candidate.key)
              return next
            })
          return
        }
        const response = await runtimeApi.getRuntimeTranscript({
          ...candidate.address,
          limit: 1,
          includeFullContent: false,
        })
        if (
          !mounted.current ||
          attempted.current.get(candidate.key) !== candidate.signature ||
          response.origin?.initiatedBy !== 'stand_in'
        )
          return
        const task = {
          ...result.task,
          runtimeHandle: { ...result.task.runtimeHandle, origin: response.origin },
        }
        const item: RuntimeTaskReminderItem = {
          key: candidate.key,
          address: candidate.address,
          task,
          workspace: {
            deviceId: candidate.address.deviceId,
            available: true,
            workspacePath: task.workspacePath,
            tasks: [task],
          },
          projectName: '',
        }
        setLoaded(current => new Map(current).set(candidate.key, item))
      })().catch(error => {
        if (!mounted.current) return
        console.warn('[Wework] Failed to read unlisted execution for collaboration notifications', {
          address: candidate.address,
          error,
        })
        attempted.current.delete(candidate.key)
      })
    }
  }, [pending, reader, runtimeApi])

  return useMemo(() => {
    const visible = new Set(items.map(item => item.key))
    return [
      ...items,
      ...[...loaded.values()].filter(
        item => !visible.has(item.key) && snapshot.tasks.has(item.key)
      ),
    ]
  }, [items, loaded, snapshot.tasks])
}
