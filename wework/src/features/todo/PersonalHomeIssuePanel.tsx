import { useEffect, useState, type ReactNode } from 'react'
import type {
  CollaborationIssue,
  CollaborationIssueDetailRenderContext,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { mergeIssueReadConfirmation } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'
import { useStableEvent } from '@/features/workbench/useStableEvent'
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
}: PersonalHomeIssueDetailContext & {
  api: SharedWorkspaceApi
  renderDetail(context: CollaborationIssueDetailRenderContext): ReactNode
  onCreateTask?(issue: CollaborationIssue): Promise<void> | void
  refreshKey: number
}) {
  const { t } = useTranslation('common')
  const publishUpdated = useStableEvent(onUpdated)
  const [snapshot, setSnapshot] = useState<{
    api: SharedWorkspaceApi
    id: string
    detail?: Pick<
      CollaborationIssueDetailRenderContext,
      'issue' | 'allIssues' | 'assignments' | 'taskBindings'
    >
    failed?: boolean
  }>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!active) return
    let current = true
    void (async () => {
      const item = await api.issues.get(issue.id)
      if (String(item.cloud_project_id) !== String(project.id))
        throw new Error('Issue project identity changed')
      const [items, assignments, taskBindings] = await Promise.all([
        api.issues.list(String(project.id)),
        api.assignments?.list(issue.id) ?? Promise.resolve([]),
        api.taskBindings?.list(issue.id, String(project.id)) ?? Promise.resolve([]),
      ])
      if (current) {
        setSnapshot({
          api,
          id: issue.id,
          detail: {
            issue: item,
            allIssues: items,
            assignments,
            taskBindings,
          },
        })
        if (item.title !== issue.title || item.version !== issue.version)
          publishUpdated({ ...issue, ...item })
      }
    })().catch(() => {
      if (current) setSnapshot({ api, id: issue.id, failed: true })
    })
    return () => {
      current = false
    }
  }, [api, issue.id, project.id, active, revision, refreshKey, publishUpdated])
  const current = snapshot?.api === api && snapshot?.id === issue.id ? snapshot : undefined
  if (current?.failed)
    return (
      <div role="alert" className="p-5 text-sm text-error">
        {t('personalHome.detailFailed')}
        <button
          type="button"
          data-testid="personal-home-detail-retry"
          className="ml-2 min-h-11 underline md:min-h-8"
          onClick={() => setRevision(value => value + 1)}
        >
          {t('standIn.reload')}
        </button>
      </div>
    )
  if (!current?.detail)
    return (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('personalHome.loading')}
      </p>
    )
  const detail = current.detail
  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col"
      data-testid="work-item-context-panel"
    >
      {renderDetail({
        ...detail,
        api,
        project,
        onClose: () => onClose?.(),
        onChange: updated => {
          setSnapshot(previous =>
            previous?.detail
              ? { ...previous, detail: { ...previous.detail, issue: updated } }
              : previous
          )
          onUpdated({ ...issue, ...updated })
        },
        onRead: updated =>
          setSnapshot(previous =>
            previous?.detail
              ? {
                  ...previous,
                  detail: {
                    ...previous.detail,
                    issue: mergeIssueReadConfirmation(previous.detail.issue, updated),
                  },
                }
              : previous
          ),
        onOpenRelatedIssue: related => onOpenIssue({ ...issue, ...related }),
        onCreateTask: onCreateTask ? () => void onCreateTask(detail.issue) : undefined,
      })}
    </div>
  )
}
