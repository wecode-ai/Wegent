import { AlarmClock, Loader2 } from 'lucide-react'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { useTranslation } from '@/hooks/useTranslation'
import { useRuntimeTaskRateLimitWait } from '@/features/workbench/useRuntimeTaskRateLimitWait'
import type { RuntimeTaskAddress } from '@/types/api'

export function MobileRuntimeTaskRunningStatus({
  address,
  testId,
}: {
  address: RuntimeTaskAddress
  testId: string
}) {
  const { t } = useTranslation()
  const rateLimitWaiting = useRuntimeTaskRateLimitWait(address)
  const label = t(
    rateLimitWaiting ? 'workbench.runtime_task_rate_limit_wait' : 'workbench.runtime_task_running'
  )
  return (
    <span
      data-testid={testId}
      data-rate-limit-waiting={rateLimitWaiting || undefined}
      role="status"
      aria-label={label}
      title={label}
      className="ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center text-text-secondary"
    >
      {rateLimitWaiting ? (
        <AlarmClock className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <CompositedSpinner icon={Loader2} className="h-3.5 w-3.5" />
      )}
    </span>
  )
}
