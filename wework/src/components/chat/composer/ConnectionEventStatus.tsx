import { Bell, CircleAlert } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { connectionEventSubscriptions } from '@/lib/runtime-connection-events'
import { ResourceObservationStatus } from '@/components/common/ResourceObservationStatus'
import { connectionObservationHealth } from '@/features/workbench/resourceObservation'
import type { RuntimeTaskInteractionStatus } from '@/types/api'

export function ConnectionEventStatus({
  subscriptions,
  interactionStatus,
}: {
  subscriptions?: unknown
  interactionStatus?: RuntimeTaskInteractionStatus | null
}) {
  const { t } = useTranslation('common')
  const items = connectionEventSubscriptions(subscriptions)
  if (!items.length) return null

  return (
    <div
      data-testid="connection-event-status"
      className="col-span-full w-full min-w-0 basis-full px-2.5 text-xs text-text-secondary"
    >
      {items.map(item => {
        const observation = connectionObservationHealth(item)
        const received = ['pending', 'resuming_goal'].includes(item.status)
        const setupFailed = item.status === 'preparing' && Boolean(item.error_code)
        const executionFailed = ['error', 'needs_attention'].includes(item.status)
        const observing = item.status === 'armed'
        const failed = setupFailed || executionFailed || (observing && Boolean(observation.error))
        const Icon = failed ? CircleAlert : Bell
        const label = setupFailed
          ? observation.state === 'auth_required'
            ? t('workbench.observation_auth_required', '连接需要重新授权')
            : t(
                'workbench.connection_event_setup_failed',
                '事件等待尚未设置成功，请让 AI 检查并重试'
              )
          : executionFailed
            ? t('workbench.connection_event_needs_attention', '事件继续执行遇到问题，请查看会话')
            : item.status === 'preparing'
              ? t('workbench.connection_event_preparing', '正在设置事件等待')
              : received
                ? interactionStatus
                  ? t(
                      'workbench.connection_event_waiting_human',
                      '已收到事件，等待你处理当前问题或确认'
                    )
                  : t('workbench.connection_event_pending', '已收到事件，等待会话继续执行')
                : t('workbench.connection_event_waiting', '等待事件，到达后自动继续')
        return (
          <div
            key={item.subscription_key}
            className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5"
            role="status"
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {observing ? (
              <ResourceObservationStatus observation={observation}>
                {label}
              </ResourceObservationStatus>
            ) : (
              <span>{label}</span>
            )}
            <span className="min-w-0 truncate" title={item.source.name}>
              · {item.source.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}
