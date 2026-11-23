import { Button as ControlButton } from '../markdown/Button'
import { ProjectLoadingSkeleton } from '../project-shell'
import type { createCollaborationTranslator } from '../i18n'

export function PlatformInvitedIssueAccess({
  error,
  loadError,
  retry,
  translate,
}: {
  error: string | null
  loadError: string | null
  retry(): void
  translate: ReturnType<typeof createCollaborationTranslator>
}) {
  if (error)
    return (
      <div className="collaboration-alert" role="alert">
        {error}
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="collaboration-issue-access-retry"
          onClick={retry}
          className="min-h-11 px-2 underline md:min-h-8"
        >
          {translate('common.retry', '重试')}
        </ControlButton>
      </div>
    )
  if (loadError)
    return (
      <div className="collaboration-alert" role="alert">
        {loadError}
      </div>
    )
  return <ProjectLoadingSkeleton label={translate('common.loading', '正在加载…')} layout="board" />
}
