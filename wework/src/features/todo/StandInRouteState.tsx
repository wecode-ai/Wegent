import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInRouteLoading() {
  const { t } = useTranslation('common')
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-5 text-sm text-text-secondary"
      role="status"
      data-testid="stand-in-route-loading"
    >
      {t('standIn.loading')}
    </div>
  )
}

export function StandInRouteFailure({
  title,
  description,
  onRetry,
  onReturn,
}: {
  title: string
  description: string
  onRetry?(): void
  onReturn?(): void
}) {
  const { t } = useTranslation('collaborationExp')
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-5 py-8"
      role="alert"
      data-testid="stand-in-route-error"
    >
      <div className="w-full max-w-md space-y-3">
        <h1 className="heading-sm font-medium">{title}</h1>
        <p className="text-sm text-text-secondary">{description}</p>
        <div className="flex flex-wrap gap-2">
          {onReturn && (
            <Button
              className="min-h-11 md:min-h-8"
              data-testid="stand-in-route-return"
              onClick={onReturn}
            >
              {t('assistant.entry.back')}
            </Button>
          )}
          {onRetry && (
            <Button
              variant={onReturn ? 'outline' : undefined}
              className="min-h-11 md:min-h-8"
              data-testid="stand-in-route-retry"
              onClick={onRetry}
            >
              {t('assistant.retry')}
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
