import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { weworkIssueScheme } from './scheme'

export function NotificationEventsBridge({
  chatStream,
  currentUserId,
  localUserId,
}: Pick<WorkbenchServices, 'chatStream'> & { currentUserId?: number; localUserId?: number }) {
  const { t } = useTranslation('common')
  const deliveredAssignments = useRef(new Set<string>())
  useEffect(
    () =>
      chatStream.subscribe({
        onWeworkNotification: () => window.dispatchEvent(new Event('wework-notifications-changed')),
        onProjectTaskAssigned: payload => {
          if (getDesktopWindowLabel() !== 'main') return
          const localIdentities = [localUserId, currentUserId].filter(id => id != null).map(String)
          if (
            payload.projectStore === 'local' &&
            !localIdentities.includes(payload.recipientUserId ?? '')
          )
            return
          const recipientId = payload.recipientUserId ?? currentUserId
          if (payload.assignmentId) {
            const key = `${recipientId}:${payload.projectStore}:${payload.projectId}:${payload.assignmentId}`
            if (deliveredAssignments.current.has(key)) return
            deliveredAssignments.current.add(key)
          }
          void sendSystemNotification({
            title: t('workbench.project_task_assigned_notification_title'),
            body: t('workbench.project_task_assigned_notification_body', {
              assigner: payload.assignerName,
              task: payload.itemTitle,
              project: payload.projectName,
            }),
            url: weworkIssueScheme(payload.projectId, payload.itemId, payload.projectStore),
          })
        },
      }),
    [chatStream, currentUserId, localUserId, t]
  )
  return null
}
