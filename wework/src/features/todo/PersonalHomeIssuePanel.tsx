import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type {
  CollaborationIssue,
  CollaborationIssueDetailRenderContext,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { PersonalHomeIssueDetail } from './personalHomeIssueDetail'
import type { PersonalHomeIssueDetailContext } from './WeworkPersonalHome'

/** Load an authorized Issue and reuse the board's complete detail and task workflow. */
export function PersonalHomeIssuePanel({
  api,
  issue,
  project,
  active,
  onUpdated,
  onOpenIssue,
  onClose,
  renderDetail,
  onCreateTask,
  refreshKey,
  presentation,
}: PersonalHomeIssueDetailContext & {
  api: SharedWorkspaceApi
  renderDetail(context: CollaborationIssueDetailRenderContext): ReactNode
  onCreateTask?(issue: CollaborationIssue): Promise<void> | void
  refreshKey: number
}) {
  const { t } = useTranslation('common')
  const scope = useMemo(
    () => new PersonalHomeIssueDetail(api, issue.id, String(project.id), project.project_store),
    [api, issue.id, project.id, project.project_store]
  )
  const [activation, setActivation] = useState({ active, revision: 0 })
  if (activation.active !== active) setActivation({ active, revision: activation.revision + 1 })
  const version = String(refreshKey) + ':' + activation.revision
  const subscribe = useCallback(
    (notify: () => void) =>
      active
        ? scope.subscribe({ notify, publish: onUpdated, summary: issue }, version)
        : () => undefined,
    [active, issue, onUpdated, scope, version]
  )
  const current = useSyncExternalStore(subscribe, scope.getSnapshot, scope.getSnapshot)
  const saveIssue = scope.save
  const confirmRead = scope.confirmRead
  const error = current?.failed ? (
    <div role="alert" className="p-5 text-sm text-error">
      {t('personalHome.detailFailed')}
      <button
        type="button"
        data-testid="personal-home-detail-retry"
        className="ml-2 min-h-11 underline md:min-h-8"
        onClick={() => void scope.reload()}
      >
        {t('standIn.reload')}
      </button>
    </div>
  ) : null
  if (!current?.detail) {
    const content = error ?? (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('personalHome.loading')}
      </p>
    )
    if (presentation !== 'drawer') return content
    return (
      <>
        <header className="flex items-center justify-between gap-2 border-b border-border p-4">
          <span className="truncate">{issue.title}</span>
          <button
            type="button"
            data-testid="cloud-todo-detail-close"
            aria-label={t('independentIssues.close')}
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md md:h-8 md:w-8 hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {content}
      </>
    )
  }
  const detail = current.detail
  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col"
      data-testid="work-item-context-panel"
    >
      {error}
      {renderDetail({
        ...detail,
        api,
        project,
        onClose: () => onClose?.(),
        onChange: saveIssue,
        onRead: confirmRead,
        onOpenRelatedIssue: onOpenIssue,
        onCreateTask: onCreateTask ? () => void onCreateTask(detail.issue) : undefined,
      })}
    </div>
  )
}
