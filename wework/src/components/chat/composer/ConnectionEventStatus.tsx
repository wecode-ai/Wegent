import { createConnectionEventStatusSource } from './connectionEventStatusSource'
import { useCallback, useId, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronRight, CircleAlert, Radio } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { connectionEventCondition } from '@/lib/connection-event-condition'
import { connectionEventSubscriptions } from '@/lib/runtime-connection-events'
import { ResourceObservationStatus } from '@/components/common/ResourceObservationStatus'
import { connectionObservationHealth } from '@/features/workbench/resourceObservation'
import type { RuntimeTaskInteractionStatus } from '@/types/api'

export function ConnectionEventStatus({
  subscriptions,
  interactionStatus,
  onCancel,
  unavailable = false,
  unsupported = false,
}: {
  subscriptions?: unknown
  interactionStatus?: RuntimeTaskInteractionStatus | null
  onCancel?: (key: string) => Promise<void>
  unavailable?: boolean
  unsupported?: boolean
}) {
  const { t } = useTranslation('common')
  const conditionId = useId()
  const [expanded, setExpanded] = useState<string[]>([])
  const [source] = useState(createConnectionEventStatusSource)
  const { cancelled, announcement, pending, unsupportedFailure, errors } = useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot
  )
  const bindContainer = useCallback(
    (node: HTMLDivElement | null) => source.bindContainer(node),
    [source]
  )
  const cancellationUnsupported = unsupported || unsupportedFailure
  const items = connectionEventSubscriptions(subscriptions).filter(
    item => !cancelled.includes(item.subscription_key)
  )
  if (!items.length) {
    return announcement ? (
      <div
        ref={bindContainer}
        tabIndex={-1}
        onBlur={() => source.clearAnnouncement()}
        data-testid="connection-event-cancel-feedback"
        role="status"
        className="col-span-full min-h-8 min-w-0 truncate px-2.5 py-1 text-xs text-text-secondary"
        title={announcement}
      >
        {announcement}
      </div>
    ) : null
  }
  const cancel = (key: string, sourceName: string) => {
    if (!onCancel || unavailable || cancellationUnsupported) return
    return source.cancel(
      key,
      t('workbench.connection_event_cancelled', { source: sourceName }),
      onCancel
    )
  }

  return (
    <div
      ref={bindContainer}
      tabIndex={-1}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) source.clearAnnouncement()
      }}
      data-testid="connection-event-status"
      className="col-span-full w-full min-w-0 basis-full px-2.5 text-xs text-text-secondary"
    >
      {announcement && (
        <div role="status" className="min-h-8 min-w-0 truncate py-1" title={announcement}>
          {announcement}
        </div>
      )}
      {items.map((item, index) => {
        const conditionOpen = expanded.includes(item.subscription_key)
        const detailsId = `${conditionId}-${index}`
        const summary = item.source.configurationSummary
        const sourceName =
          typeof summary === 'string' && summary.trim()
            ? `${item.source.name} · ${summary}`
            : item.source.name
        const observation = connectionObservationHealth(item)
        const received = ['pending', 'resuming_goal'].includes(item.status)
        const setupFailed = item.status === 'preparing' && Boolean(item.error_code)
        const executionFailed = ['error', 'needs_attention'].includes(item.status)
        const observing = item.status === 'armed'
        const failed = setupFailed || executionFailed || (observing && Boolean(observation.error))
        const Icon = failed ? CircleAlert : Radio
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
          <div key={item.subscription_key} className="min-w-0">
            <div className="flex min-h-8 min-w-0 items-center gap-1.5">
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <div role="status" className="min-w-0 flex-1 truncate">
                {observing ? (
                  <ResourceObservationStatus observation={observation}>
                    {label}
                  </ResourceObservationStatus>
                ) : (
                  <span>{label}</span>
                )}
                <span title={sourceName}>
                  {' · '}
                  {sourceName}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 min-h-11 shrink-0 gap-1 whitespace-nowrap px-2 text-xs text-text-secondary md:min-h-7"
                data-testid="connection-event-condition-toggle"
                aria-expanded={conditionOpen}
                aria-controls={detailsId}
                onClick={() =>
                  setExpanded(current =>
                    current.includes(item.subscription_key)
                      ? current.filter(key => key !== item.subscription_key)
                      : [...current, item.subscription_key]
                  )
                }
              >
                <ChevronRight
                  aria-hidden="true"
                  className={conditionOpen ? 'h-3.5 w-3.5 rotate-90' : 'h-3.5 w-3.5'}
                />
                {t('workbench.event_condition_label', '等待条件')}
              </Button>
              {onCancel && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 min-h-11 shrink-0 whitespace-nowrap px-2 text-xs text-text-secondary md:min-h-7"
                  data-testid="cancel-connection-event-subscription"
                  aria-label={t('workbench.connection_event_cancel_source', {
                    source: sourceName,
                  })}
                  disabled={
                    unavailable ||
                    cancellationUnsupported ||
                    pending.includes(item.subscription_key)
                  }
                  onClick={() => void cancel(item.subscription_key, sourceName)}
                >
                  {pending.includes(item.subscription_key)
                    ? t('workbench.connection_event_cancelling', '正在取消')
                    : t('workbench.connection_event_cancel', '取消监听')}
                </Button>
              )}
            </div>
            <p
              id={detailsId}
              hidden={!conditionOpen}
              className="whitespace-pre-wrap break-words pb-1 pl-5"
              data-testid="connection-event-condition"
            >
              {conditionOpen && connectionEventCondition(item.match, t)}
            </p>
            {onCancel && cancellationUnsupported && !unavailable && (
              <span className="block" data-testid="connection-event-upgrade-required">
                {t(
                  'workbench.connection_event_upgrade_required',
                  '此设备需升级执行器以使用事件监听'
                )}
              </span>
            )}
            {onCancel && unavailable && (
              <span className="block">
                {t('workbench.connection_event_cancel_unavailable', '设备离线，恢复后可取消')}
              </span>
            )}
            {errors[item.subscription_key] && (
              <span role="alert" className="block text-destructive">
                {t('workbench.connection_event_cancel_failed', '取消失败，请重试')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
