import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import type { StandInInboxWork } from '@/api/standIn'
import type { CollaborationProject } from '@wegent/collaboration'
import { standInOrigin } from '@/features/notifications/standInNotifications'
import { inboxRuntimeItem } from './useStandInInbox'

export function mergeStandInWorkItems(
  items: RuntimeTaskReminderItem[],
  inbox: StandInInboxWork[],
  deviceId: string | undefined,
  projects: CollaborationProject[] = []
) {
  const merged = new Map(
    items.map(item => {
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
