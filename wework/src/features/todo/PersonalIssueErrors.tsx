import { useTranslation } from '@/hooks/useTranslation'

// One page-level live region; each data source retains its own retry action.
export function PersonalIssueErrors({
  projects,
  independent,
}: {
  projects?: { error: boolean; reload(): void }
  independent: { error?: string | null; reload(): void }
}) {
  const { t } = useTranslation('common')
  if (!projects?.error && !independent.error) return null
  return (
    <div
      role="alert"
      data-testid="personal-issues-errors"
      className="space-y-2 py-4 text-sm text-error"
    >
      {projects?.error ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('personalHome.loadFailed')}</span>
          <button
            type="button"
            data-testid="personal-home-retry"
            className="min-h-11 underline md:min-h-8"
            onClick={projects.reload}
          >
            {t('standIn.reload')}
          </button>
        </div>
      ) : null}
      {independent.error ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {t('independentIssues.independent')}: {independent.error}
          </span>
          <button
            type="button"
            data-testid="independent-issues-retry"
            onClick={independent.reload}
            className="min-h-11 rounded-md px-3 underline md:min-h-8"
          >
            {t('independentIssues.retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
