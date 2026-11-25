import { Button as ControlButton } from '../markdown/Button'

export function PersonalIssueErrors({
  state,
  translate: t,
}: {
  state: { error: boolean; reload(): void }
  translate(key: string): string
}) {
  if (!state.error) return null
  return (
    <div
      role="alert"
      data-testid="personal-issues-errors"
      className="flex flex-wrap items-center gap-2 py-4 text-sm text-error"
    >
      <span>{t('personalHome.loadFailed')}</span>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="personal-home-retry"
        className="min-h-11 underline md:min-h-8"
        onClick={state.reload}
      >
        {t('independentIssues.retry')}
      </ControlButton>
    </div>
  )
}
