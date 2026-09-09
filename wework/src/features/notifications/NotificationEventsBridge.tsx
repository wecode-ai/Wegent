import { useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

export function NotificationEventsBridge({ chatStream }: Pick<WorkbenchServices, 'chatStream'>) {
  const { t } = useTranslation('common')
  useEffect(
    () =>
      chatStream.subscribe({
        onWeworkNotification: () => window.dispatchEvent(new Event('wework-notifications-changed')),
        onProjectTaskAssigned: payload => {
          if (getDesktopWindowLabel() !== 'main') return
          void sendSystemNotification({
            title: t('workbench.project_task_assigned_notification_title'),
            body: t('workbench.project_task_assigned_notification_body', {
              assigner: payload.assignerName,
              task: payload.itemTitle,
              project: payload.projectName,
            }),
          })
        },
      }),
    [chatStream, t]
  )
  return null
}
