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
  const ordinary = useRef(new Set<string>())
  const retryTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const mounted = useRef(false)
  useEffect(() => {
    const timers = retryTimers.current
    mounted.current = true
    return () => {
      mounted.current = false
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
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
      if (ordinary.current.has(candidate.key)) continue
      if (attempted.current.get(candidate.key) === candidate.signature) continue
      attempted.current.set(candidate.key, candidate.signature)
      const read = (attempt: number) => {
        void (async () => {
          const result = await reader.readTask(candidate.address.deviceId, candidate.address.taskId)
          if (!mounted.current || attempted.current.get(candidate.key) !== candidate.signature)
            return
          if (!result.success || !result.task) {
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
          if (!mounted.current || attempted.current.get(candidate.key) !== candidate.signature)
            return
          if (response.origin?.initiatedBy !== 'stand_in') {
            if (response.origin) ordinary.current.add(candidate.key)
            return
          }
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
          if (!mounted.current || attempted.current.get(candidate.key) !== candidate.signature)
            return
          console.warn(
            '[Wework] Failed to read unlisted execution for collaboration notifications',
            {
              address: candidate.address,
              error,
            }
          )
          if (attempt >= 2) {
            attempted.current.delete(candidate.key)
            return
          }
          const timer = setTimeout(
            () => {
              retryTimers.current.delete(timer)
              if (mounted.current && attempted.current.get(candidate.key) === candidate.signature)
                read(attempt + 1)
            },
            500 * (attempt + 1)
          )
          retryTimers.current.add(timer)
        })
      }
      read(0)
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
