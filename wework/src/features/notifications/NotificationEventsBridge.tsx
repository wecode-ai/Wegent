import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { ProjectTaskAssignedPayload } from '@/stream/chatStream'
import { openWeworkScheme } from './schemeEvents'
import { useTranslation } from '@/hooks/useTranslation'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

export function NotificationEventsBridge({ chatStream }: Pick<WorkbenchServices, 'chatStream'>) {
  const { t } = useTranslation('common')
  const [pending, setPending] = useState<ProjectTaskAssignedPayload | null>(null)
  useEffect(
    () =>
      chatStream.subscribe({
        onWeworkNotification: () => window.dispatchEvent(new Event('wework-notifications-changed')),
        onProjectTaskAssigned: payload => {
          if (getDesktopWindowLabel() !== 'main') return
          if (payload.assignmentId) setPending(payload)
          void sendSystemNotification({
            title: payload.assignmentId
              ? t('todo.human_reply_notification_title', { title: payload.itemTitle })
              : t('workbench.project_task_assigned_notification_title'),
            body:
              payload.instruction ||
              t('workbench.project_task_assigned_notification_body', {
                assigner: payload.assignerName,
                task: payload.itemTitle,
                project: payload.projectName,
              }),
            ...(payload.url ? { schemeUrl: payload.url } : {}),
          })
        },
      }),
    [chatStream, t]
  )
  return pending ? (
    <aside
      role="status"
      data-testid="human-assignment-notification"
      className="fixed right-4 top-14 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-background p-4 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">
          {t('todo.human_reply_notification_title', { title: pending.itemTitle })}
        </p>
        <button
          type="button"
          data-testid="human-assignment-notification-dismiss"
          aria-label={t('todo.human_reply_dismiss')}
          onClick={() => setPending(null)}
          className="flex min-h-11 min-w-11 items-center justify-center md:min-h-7 md:min-w-7"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-2 line-clamp-3 text-sm text-text-muted">{pending.instruction}</p>
      <button
        type="button"
        data-testid="human-assignment-notification-reply"
        onClick={() => {
          if (pending.url) openWeworkScheme(pending.url)
          setPending(null)
        }}
        className="mt-3 min-h-11 text-sm underline underline-offset-2 md:min-h-7"
      >
        {t('todo.human_reply_open')}
      </button>
    </aside>
  ) : null
}
