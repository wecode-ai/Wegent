import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function IssueWaitingTime({ since }: { since: string | null }) {
  const { t } = useTranslation('common')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!since) return
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [since])
  const start = since ? Date.parse(since) : NaN
  if (!Number.isFinite(start))
    return <span className="text-xs text-text-muted">{t('issueParticipation.wait_unknown')}</span>
  const minutes = Math.max(0, Math.floor((now - start) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor(minutes / 60)
  const duration = days
    ? t('issueParticipation.days', { count: days, hours: hours % 24 })
    : hours
      ? t('issueParticipation.hours', { count: hours, minutes: minutes % 60 })
      : t('issueParticipation.minutes', { count: minutes })
  return (
    <time
      dateTime={since!}
      title={t('issueParticipation.since', { time: new Date(start).toLocaleString() })}
      className="text-xs text-text-secondary"
      data-testid="issue-waiting-time"
    >
      {t('issueParticipation.waiting_duration', { duration })}
    </time>
  )
}
