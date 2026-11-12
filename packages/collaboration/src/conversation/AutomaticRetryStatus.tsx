import { useEffect, useState } from 'react'
import type { CollaborationTranslate } from '../i18n'
import { formatDuration } from './blocks/processingDuration'

type AutomaticRetryStatusProps = {
  reason: 'overload' | 'quota'
  retryAt?: number | null
  translate: CollaborationTranslate
}

export function AutomaticRetryStatus(props: AutomaticRetryStatusProps) {
  return <RetryCountdown key={props.retryAt ?? 'unknown'} {...props} />
}

function RetryCountdown({ reason, retryAt, translate }: AutomaticRetryStatusProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!retryAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retryAt])
  const remaining = retryAt ? Math.max(0, retryAt - now) : 0
  const key =
    reason === 'quota'
      ? !retryAt
        ? 'quota_wait_unknown'
        : remaining > 0
          ? 'quota_wait_until'
          : 'quota_checking'
      : remaining > 0
        ? 'overload_retry_in'
        : 'overload_retrying'
  const message = translate(`conversation.tool_activity.${key}`, undefined, {
    remaining: formatDuration(Math.ceil(remaining / 1000) * 1000, translate.locale),
  })
  const waiting = remaining > 0
  return (
    <div
      className="min-w-0 py-1 text-sm text-text-muted"
      data-testid={`runtime-${reason}-wait-status`}
    >
      <span role="status" className={waiting ? 'sr-only' : undefined}>
        {waiting ? translate(`conversation.tool_activity.${reason}_waiting`) : message}
      </span>
      {waiting && <span>{message}</span>}
    </div>
  )
}
