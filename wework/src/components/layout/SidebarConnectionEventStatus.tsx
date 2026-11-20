import { sidebarEventState } from '@/lib/sidebar-event-state'
import { CircleAlert, CircleArrowDown, Radio } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import type { ConnectionEventSubscription } from '@/lib/runtime-connection-events'

export function SidebarConnectionEventStatus({
  subscription,
  taskId,
}: {
  subscription: ConnectionEventSubscription
  taskId: string
}) {
  const { t } = useTranslation('common')
  const state = sidebarEventState(subscription)
  const failed = state === 'execution_error' || state === 'observation_error'
  const label =
    state === 'execution_error'
      ? t('workbench.connection_event_needs_attention', '事件继续执行遇到问题，请查看会话')
      : state === 'received'
        ? t('workbench.sidebar_event_received', '事件已到达，等待继续')
        : state === 'observation_error'
          ? t('workbench.sidebar_event_error', '事件监听异常')
          : state === 'preparing'
            ? t('workbench.connection_event_preparing', '正在设置事件等待')
            : t('workbench.sidebar_event_waiting', '等待事件')
  const Icon = failed ? CircleAlert : state === 'received' ? CircleArrowDown : Radio
  return (
    <Tooltip label={label} testId={`runtime-local-task-event-tooltip-${taskId}`}>
      <span
        data-testid={`runtime-local-task-event-${taskId}`}
        data-state={state}
        role="status"
        aria-label={label}
        className="inline-flex h-6 w-6 items-center justify-center text-text-secondary"
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
    </Tooltip>
  )
}
