import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useCallback, useEffect, useState } from 'react'
import type { StandInExecutorApi, StandInInboxWork, StandInSourceError } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'

export function inboxRuntimeItem(
  work: StandInInboxWork,
  deviceId: string,
  runtimeItem?: RuntimeTaskReminderItem
): RuntimeTaskReminderItem {
  // Archived inbox state must not be overwritten by a stale active-work snapshot.
  const task = (work.task?.status === 'archived' ? work.task : runtimeItem?.task) ??
    work.task ?? {
      taskId: work.taskId,
      title: work.title,
      runtime: 'codex' as const,
      workspacePath: '',
      status: work.status === 'sent' ? 'done' : 'pending',
      running: false,
      updatedAt: work.updatedAt,
    }
  const origin = {
    ...(task.runtimeHandle?.origin as Record<string, unknown>),
    initiatedBy: 'stand_in',
    standInId: work.roleId,
    inboxWorkId: work.id,
    inboxStatus: work.task ? undefined : work.status,
    previewText: work.latestMessage?.text ?? '',
    messageCount: work.messageCount,
  }
  return {
    key: `${deviceId}\0${work.taskId}`,
    address: { deviceId, taskId: work.taskId },
    task: {
      ...task,
      error: task.error ?? work.error,
      runtimeHandle: { ...task.runtimeHandle, origin },
    },
    projectName: work.source.name,
    lifecycle: runtimeItem?.lifecycle,
    workspace: { deviceId, available: true, workspacePath: task.workspacePath, tasks: [task] },
  }
}

export function useStandInInbox(
  api: StandInExecutorApi | undefined,
  userId: number,
  deviceId?: string,
  enabled = true,
  connectionScope = ''
) {
  const [data, setData] = useState<{
    api: StandInExecutorApi
    scope: string
    items: StandInInboxWork[]
    sourceErrors: StandInSourceError[]
  }>()
  const [failure, setFailure] = useState<{
    api: StandInExecutorApi
    scope: string
    error: string
  }>()
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const scope = JSON.stringify([connectionScope, userId, deviceId])
  useEffect(() => {
    if (!enabled || !api || !deviceId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.inbox(userId, deviceId)
        if (active) {
          setData({ ...next, api, scope })
          setFailure(undefined)
        }
      } catch (cause) {
        if (active) setFailure({ api, scope, error: getStandInErrorMessage(cause) })
      } finally {
        if (active) timer = setTimeout(poll, 3000)
      }
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, userId, deviceId, revision, scope, enabled])
  const current = data?.api === api && data?.scope === scope ? data : undefined
  const error = failure?.api === api && failure?.scope === scope ? failure.error : null
  return {
    scope: current?.scope,
    items: current?.items ?? [],
    sourceErrors: current?.sourceErrors ?? [],
    error,
    refresh,
  }
}
