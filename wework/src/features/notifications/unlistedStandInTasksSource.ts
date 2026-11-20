import { isPersonalStandInTask } from '@/features/workbench/runtimeTaskNotificationContent'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'

export interface UnlistedTaskCandidate {
  key: string
  address: RuntimeTaskReminderItem['address']
  signature: string
}
interface Retry {
  candidate: UnlistedTaskCandidate
  attempt: number
  dueAt: number
  timer: ReturnType<typeof setTimeout>
}

/** One API owner discovers hidden executions and owns their bounded read retries. */
export function createUnlistedStandInTasksSource(
  reader: StandInExecutorApi | undefined,
  runtimeApi: WorkbenchServices['runtimeWorkApi']
) {
  let loaded = new Map<string, RuntimeTaskReminderItem>()
  const attempted = new Map<string, string>()
  const ordinary = new Set<string>()
  const listeners = new Set<() => void>()
  const retries = new Set<Retry>()
  let suspended: Retry[] = []
  let generation = 0
  const current = (candidate: UnlistedTaskCandidate, owner: number) =>
    listeners.size > 0 &&
    owner === generation &&
    attempted.get(candidate.key) === candidate.signature
  const publish = (next: typeof loaded) => {
    loaded = next
    listeners.forEach(listener => listener())
  }
  const schedule = (candidate: UnlistedTaskCandidate, attempt: number, dueAt: number) => {
    const owner = generation
    const retry: Retry = {
      candidate,
      attempt,
      dueAt,
      timer: setTimeout(
        () => {
          retries.delete(retry)
          if (current(candidate, owner)) void read(candidate, attempt, owner)
        },
        Math.max(0, dueAt - Date.now())
      ),
    }
    retries.add(retry)
  }
  const read = async (candidate: UnlistedTaskCandidate, attempt: number, owner: number) => {
    if (!reader || !runtimeApi || !current(candidate, owner)) return
    try {
      const result = await reader.readTask(candidate.address.deviceId, candidate.address.taskId)
      if (!current(candidate, owner)) return
      if (!result.success || !result.task) {
        const next = new Map(loaded)
        next.delete(candidate.key)
        publish(next)
        return
      }
      const response = await runtimeApi.getRuntimeTranscript({
        ...candidate.address,
        limit: 1,
        includeFullContent: false,
      })
      if (!current(candidate, owner)) return
      if (
        response.origin?.initiatedBy !== 'stand_in' &&
        !isPersonalStandInTask({
          task: { ...result.task, runtimeHandle: { origin: response.origin } },
        })
      ) {
        if (response.origin) ordinary.add(candidate.key)
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
      publish(new Map(loaded).set(candidate.key, item))
    } catch (error) {
      if (!current(candidate, owner)) return
      console.warn('[Wework] Failed to read unlisted execution for collaboration notifications', {
        address: candidate.address,
        error,
      })
      if (attempt >= 2) attempted.delete(candidate.key)
      else schedule(candidate, attempt + 1, Date.now() + 500 * (attempt + 1))
    }
  }
  return {
    getSnapshot: () => loaded,
    subscribe(listener: () => void, pending: UnlistedTaskCandidate[]) {
      listeners.add(listener)
      for (const retry of suspended) {
        if (current(retry.candidate, generation))
          schedule(retry.candidate, retry.attempt, retry.dueAt)
      }
      suspended = []
      if (reader && runtimeApi) {
        for (const candidate of pending) {
          if (ordinary.has(candidate.key) || attempted.get(candidate.key) === candidate.signature)
            continue
          attempted.set(candidate.key, candidate.signature)
          void read(candidate, 0, generation)
        }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        // Cancel native timers synchronously; a same-commit handoff keeps its retry budget.
        suspended = [...retries]
        for (const retry of retries) clearTimeout(retry.timer)
        retries.clear()
        queueMicrotask(() => {
          if (listeners.size) return
          generation++
          attempted.clear()
          suspended = []
        })
      }
    },
  }
}
