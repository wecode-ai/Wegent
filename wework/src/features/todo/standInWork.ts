import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { StandInInboxWork } from '@/api/standIn'
import { STAND_IN_DINGTALK_PROVIDER } from '@/api/personalStandIn'
import type { CollaborationProject } from '@wegent/collaboration'
import { standInOrigin } from '@/features/notifications/standInNotifications'
import { inboxRuntimeItem } from './useStandInInbox'

export function mergeStandInWorkItems(
  items: RuntimeTaskReminderItem[],
  inbox: StandInInboxWork[],
  deviceId: string | undefined,
  projects: CollaborationProject[] = []
) {
  const inboxTaskIds = new Set(inbox.map(work => work.taskId))
  const visible = items.filter(item => {
    const origin = item.task.runtimeHandle?.origin as Record<string, unknown> | undefined
    const primaryDingTalk =
      origin?.standInId === '@primary' &&
      (origin.type === 'dingtalk_work' ||
        (origin.type === 'connection_work' && origin.sourceProvider === STAND_IN_DINGTALK_PROVIDER))
    return !primaryDingTalk || (item.address.deviceId === deviceId && inboxTaskIds.has(item.task.taskId))
  })
  const merged = new Map(
    visible.map(item => {
      const origin = standInOrigin(item)
      const project = projects.find(
        project =>
          project.id === origin?.cloudProjectId &&
          (project.project_store === 'local') === (origin?.projectStore === 'local')
      )
      return [item.key, { ...item, projectName: project?.name || item.projectName }]
    })
  )
  if (deviceId)
    for (const work of inbox.filter(work => work.messageCount > 0 || work.task)) {
      const key = `${deviceId}\0${work.taskId}`
      merged.set(key, inboxRuntimeItem(work, deviceId, merged.get(key)))
    }
  return [...merged.values()]
}

export function standInWorkRole(item: RuntimeTaskReminderItem): string | null {
  const origin = item.task.runtimeHandle?.origin as Record<string, unknown> | undefined
  if (origin?.initiatedBy !== 'stand_in') return null
  return typeof origin.standInId === 'string' ? origin.standInId : 'default'
}
