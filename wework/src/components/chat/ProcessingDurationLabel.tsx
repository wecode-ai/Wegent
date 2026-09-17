import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDuration } from './blocks/processingDuration'

interface ProcessingDurationLabelProps {
  startedAt: number | undefined
  completedAt: number | undefined
  isRunning: boolean
}

export function ProcessingDurationLabel({
  startedAt,
  completedAt,
  isRunning,
}: ProcessingDurationLabelProps) {
  const { t, i18n } = useTranslation('chat')
  const [now, setNow] = useState(() => Date.now())
  const isTicking = isRunning && completedAt === undefined && startedAt !== undefined

  useEffect(() => {
    if (!isTicking) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [isTicking])

  const end = completedAt ?? (isRunning ? now : undefined)
  const elapsed = startedAt === undefined || end === undefined ? 0 : Math.max(0, end - startedAt)
  const duration = formatDuration(elapsed, i18n.language)
  const label = isRunning
    ? elapsed < 1000
      ? t('assistant_status.working')
      : t('assistant_status.working_for', { duration })
    : t('assistant_status.worked_for', { duration })

  return (
    <span data-testid="processing-duration-label" className="tabular-nums">
      {label}
    </span>
  )
}
