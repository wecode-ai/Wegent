import { useTranslation } from '@/hooks/useTranslation'

export function PluginDetailLoadingSkeleton() {
  const { t } = useTranslation('common')
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('workbench.plugins_loading_plugins')}
      data-testid="plugin-detail-loading"
      className="mt-6 min-h-[360px] space-y-7"
    >
      <span className="sr-only">{t('workbench.plugins_loading_plugins')}</span>
      <div aria-hidden="true" className="space-y-3 rounded-xl bg-surface px-5 py-4">
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
      </div>
      <div aria-hidden="true" className="space-y-3">
        <div className="h-5 w-32 animate-pulse rounded bg-surface" />
        <div className="h-16 animate-pulse rounded-xl bg-surface" />
        <div className="h-16 animate-pulse rounded-xl bg-surface" />
      </div>
    </div>
  )
}
