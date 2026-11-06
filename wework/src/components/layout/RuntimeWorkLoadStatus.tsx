import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeWorkLoadState } from '@/types/workbench'

export function RuntimeWorkLoadStatus({
  load,
  hasSnapshot,
  onRetry,
}: {
  load?: RuntimeWorkLoadState
  hasSnapshot: boolean
  onRetry?: () => Promise<void>
}) {
  const { t } = useTranslation('common')
  if (!load || load.phase === 'ready' || load.phase === 'refreshing') return null
  const failed = load.phase === 'error'
  const label = failed
    ? hasSnapshot
      ? t('workbench.runtime_work_refresh_failed')
      : t('workbench.runtime_work_load_failed')
    : t('workbench.runtime_work_loading')
  return (
    <div
      data-testid="runtime-work-load-status"
      role={failed ? 'alert' : 'status'}
      className="mx-2 flex items-center gap-2 px-3 py-2 text-xs text-text-secondary"
    >
      {failed ? (
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1" title={load.error ?? undefined}>
        {label}
      </span>
      {failed && onRetry && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="runtime-work-load-retry"
          className="min-h-11 min-w-11 shrink-0 md:min-h-7 md:min-w-0"
          onClick={() => {
            void onRetry().catch(error => {
              console.error('[Wework] Task list retry failed', error)
            })
          }}
        >
          {t('workbench.retry')}
        </Button>
      )}
    </div>
  )
}
