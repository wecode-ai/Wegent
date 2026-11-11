import { useContext } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { LocalRuntimeNoticeContext } from './localRuntimeNoticeContext'

export function LocalRuntimeNotice() {
  const failure = useContext(LocalRuntimeNoticeContext)
  const { t } = useTranslation('localRuntime')
  if (!failure) return null
  return (
    <aside
      data-testid="local-runtime-initializer"
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2 text-text-primary"
    >
      <AlertCircle className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('service_unavailable_title')}</p>
        <p className="text-xs text-text-secondary">{t('service_unavailable_description')}</p>
        <p
          data-testid="local-runtime-error"
          className="line-clamp-2 break-words text-xs text-text-secondary"
          title={failure.error}
        >
          {failure.error}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="h-11 md:h-10"
        disabled={failure.retrying}
        onClick={failure.retry}
        data-testid="local-runtime-retry-button"
      >
        <RefreshCw className="h-4 w-4" />
        {t(failure.retrying ? 'starting_title' : 'retry')}
      </Button>
    </aside>
  )
}
