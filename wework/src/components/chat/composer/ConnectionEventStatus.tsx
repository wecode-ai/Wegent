import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Bell, CircleAlert } from 'lucide-react'
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
  const [cancelled, setCancelled] = useState<string[]>([])
  const [announcement, setAnnouncement] = useState('')
  const [pending, setPending] = useState<string[]>([])
  const [unsupportedFailure, setUnsupportedFailure] = useState(false)
  const cancellationUnsupported = unsupported || unsupportedFailure
  const [errors, setErrors] = useState<Record<string, boolean>>({})
  const inFlight = useRef(new Set<string>())
  const statusRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!announcement) return
    const timeout = setTimeout(() => {
      if (!statusRef.current?.contains(document.activeElement)) setAnnouncement('')
    }, 5000)
    return () => clearTimeout(timeout)
  }, [announcement])
  const items = connectionEventSubscriptions(subscriptions).filter(
    item => !cancelled.includes(item.subscription_key)
  )
  if (!items.length) {
    return announcement ? (
      <div
        ref={statusRef}
        tabIndex={-1}
        onBlur={() => setAnnouncement('')}
        data-testid="connection-event-cancel-feedback"
        role="status"
        className="col-span-full min-h-8 min-w-0 truncate px-2.5 py-1 text-xs text-text-secondary"
        title={announcement}
      >
        {announcement}
      </div>
    ) : null
  }
  const cancel = async (key: string, source: string) => {
    if (!onCancel || unavailable || cancellationUnsupported || inFlight.current.has(key)) return
    const focused = document.activeElement
    const restoreFocus = statusRef.current?.contains(focused)
    inFlight.current.add(key)
    setPending(current => [...current, key])
    setErrors(current => ({ ...current, [key]: false }))
    try {
      await onCancel(key)
      setCancelled(current => [...current, key])
      setAnnouncement(t('workbench.connection_event_cancelled', { source }))
      requestAnimationFrame(() => {
        if (
          restoreFocus &&
          (document.activeElement === focused || document.activeElement === document.body)
        ) {
          const next = statusRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
          const target = next ?? statusRef.current
          target?.focus()
        }
      })
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null
      if (code === 'unsupported_method' || code === 'connection_event_upgrade_required') {
        setUnsupportedFailure(true)
      } else {
        setErrors(current => ({ ...current, [key]: true }))
      }
    } finally {
      inFlight.current.delete(key)
      setPending(current => current.filter(value => value !== key))
    }
  }

  return (
    <div
      ref={statusRef}
      tabIndex={-1}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setAnnouncement('')
      }}
      data-testid="connection-event-status"
      className="col-span-full w-full min-w-0 basis-full px-2.5 text-xs text-text-secondary"
    >
      {announcement && (
        <div role="status" className="min-h-8 min-w-0 truncate py-1" title={announcement}>
          {announcement}
        </div>
      )}
      {items.map(item => {
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
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {observing ? (
                <ResourceObservationStatus observation={observation}>
                  {label}
                </ResourceObservationStatus>
              ) : (
                <span>{label}</span>
              )}
              <span className="min-w-0 max-w-full truncate" title={sourceName}>
                · {sourceName}
              </span>
            </div>
            <EventCondition match={item.match} />
            {onCancel && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 min-h-11 shrink-0 px-2 text-xs text-text-secondary md:min-h-7"
                data-testid="cancel-connection-event-subscription"
                aria-label={t('workbench.connection_event_cancel_source', {
                  source: sourceName,
                })}
                disabled={
                  unavailable || cancellationUnsupported || pending.includes(item.subscription_key)
                }
                onClick={() => void cancel(item.subscription_key, sourceName)}
              >
                {pending.includes(item.subscription_key)
                  ? t('workbench.connection_event_cancelling', '正在取消')
                  : t('workbench.connection_event_cancel', '取消监听')}
              </Button>
            )}
            {onCancel && cancellationUnsupported && !unavailable && (
              <span className="basis-full" data-testid="connection-event-upgrade-required">
                {t(
                  'workbench.connection_event_upgrade_required',
                  '此设备需升级执行器以使用事件监听'
                )}
              </span>
            )}
            {onCancel && unavailable && (
              <span className="basis-full">
                {t('workbench.connection_event_cancel_unavailable', '设备离线，恢复后可取消')}
              </span>
            )}
            {errors[item.subscription_key] && (
              <span role="alert" className="basis-full text-destructive">
                {t('workbench.connection_event_cancel_failed', '取消失败，请重试')}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

const EventCondition = memo(function EventCondition({ match }: { match: unknown }) {
  const { t } = useTranslation('common')
  const condition = useMemo(() => connectionEventCondition(match, t), [match, t])
  return (
    <span
      className="order-last basis-full min-w-0 truncate pb-1 pl-5 text-text-secondary"
      data-testid="connection-event-condition"
      title={condition}
    >
      {t('workbench.event_condition_label', '等待条件')}: {condition}
    </span>
  )
})
