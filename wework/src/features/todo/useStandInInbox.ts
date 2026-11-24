import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'
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
  const scope = `${userId}:${deviceId}`
  const resourceScope = JSON.stringify([connectionScope, userId, deviceId])
  const resource = useMemo(
    () =>
      createAsyncResource(resourceScope, () => api!.inbox(userId, deviceId!), {
        refreshIntervalMs: 3000,
        refreshIntervalMode: 'after-settle',
        refreshOnSubscribe: true,
      }),
    [api, userId, deviceId, resourceScope]
  )
  const query = useSyncExternalStore(
    enabled && api && deviceId ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const refresh = () => {
    if (enabled && api && deviceId) void resource.reload()
  }
  return {
    ...query.data,
    scope: query.data ? scope : undefined,
    items:
      query.data?.items.filter(
        work =>
          !work.source.delegated ||
          !!work.takenOverAt ||
          (work.delegationResult
            ? work.delegationResult.action !== 'skip'
            : work.status === 'pending')
      ) ?? [],
    sourceErrors: query.data?.sourceErrors ?? [],
    error: query.status === 'error' ? getStandInErrorMessage(query.error) : null,
    refresh,
  }
}
