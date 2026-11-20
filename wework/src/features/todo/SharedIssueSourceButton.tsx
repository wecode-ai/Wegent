import { useCallback } from 'react'
import { Link2 } from 'lucide-react'
import { usePanelData } from '@wegent/collaboration/platform'
import { ApiError } from '@/api/http'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { weworkTaskScheme } from '@/features/notifications/scheme'
import { openWeworkScheme } from '@/features/notifications/schemeEvents'
import { useTranslation } from '@/hooks/useTranslation'

export function SharedIssueSourceButton({
  api,
  issueId,
  onOpen,
}: {
  api: PersonalIssuesApi
  issueId: string
  onOpen(): void
}) {
  const { t } = useTranslation('common')
  const load = useCallback(() => api.sharedSource(issueId), [api, issueId])
  const { data: source, error, refresh } = usePanelData(load)
  if (error !== undefined && !(error instanceof ApiError && [401, 403, 404].includes(error.status)))
    return (
      <button
        type="button"
        data-testid="shared-issue-source-retry"
        className="rounded-md px-2 text-sm text-destructive hover:bg-muted"
        onClick={() => void refresh()}
      >
        {t('taskIssueShare.sourceRetry')}
      </button>
    )
  if (!source) return null
  const label = t('taskIssueShare.openSource')
  return (
    <button
      type="button"
      data-testid="independent-issue-open-source"
      aria-label={label}
      title={label}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm text-text-secondary hover:bg-muted md:min-h-8"
      onClick={() => {
        if (
          openWeworkScheme(weworkTaskScheme({ deviceId: source.device_id, taskId: source.task_id }))
        )
          onOpen()
      }}
    >
      <Link2 className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  )
}
