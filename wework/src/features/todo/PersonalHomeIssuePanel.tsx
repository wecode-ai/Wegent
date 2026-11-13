import { useEffect, useRef, useState, type ReactNode } from 'react'
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
  const publishUpdated = useStableEvent((item: CollaborationIssue) => {
    if (item.title !== issue.title || item.version !== issue.version)
      onUpdated({ ...issue, ...item })
  })
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
  const editRevision = useRef(0)
  const readConfirmation = useRef<
    | {
        api: SharedWorkspaceApi
        id: string
        issue: CollaborationIssue
      }
    | undefined
  >(undefined)
  const saveIssue = useStableEvent((updated: CollaborationIssue) => {
    editRevision.current += 1
    setSnapshot(previous =>
      previous?.api === api && previous.id === issue.id && previous.detail
        ? { ...previous, detail: { ...previous.detail, issue: updated } }
        : previous
    )
    onUpdated({ ...issue, ...updated })
  })
  const confirmRead = useStableEvent((updated: CollaborationIssue) => {
    if (snapshot?.api !== api || snapshot.id !== issue.id || !snapshot.detail) return
    const merged = mergeIssueReadConfirmation(snapshot.detail.issue, updated)
    readConfirmation.current = { api, id: issue.id, issue: merged }
    setSnapshot(previous =>
      previous?.api === api && previous.id === issue.id && previous.detail
        ? {
            ...previous,
            detail: {
              ...previous.detail,
              issue: mergeIssueReadConfirmation(previous.detail.issue, merged),
            },
          }
        : previous
    )
    onUpdated({ ...issue, ...merged })
  })
  useEffect(() => {
    if (!active) return
    let current = true
    const requestedEditRevision = editRevision.current
    void (async () => {
      const item = await api.issues.get(issue.id)
      if (String(item.cloud_project_id) !== String(project.id))
        throw new Error('Issue project identity changed')
      const [items, assignments, taskBindings] = await Promise.all([
        api.issues.list(String(project.id)),
        api.assignments?.list(issue.id) ?? Promise.resolve([]),
        api.taskBindings?.list(issue.id, String(project.id)) ?? Promise.resolve([]),
      ])
      if (current && editRevision.current === requestedEditRevision) {
        const confirmed = readConfirmation.current
        const refreshed =
          confirmed?.api === api && confirmed.id === issue.id
            ? mergeIssueReadConfirmation(item, confirmed.issue)
            : item
        setSnapshot({
          api,
          id: issue.id,
          detail: {
            issue: refreshed,
            allIssues: items,
            assignments,
            taskBindings,
          },
        })
        publishUpdated(refreshed)
      }
    })().catch(() => {
      if (current && editRevision.current === requestedEditRevision)
        setSnapshot(previous => ({
          api,
          id: issue.id,
          detail: previous?.api === api && previous.id === issue.id ? previous.detail : undefined,
          failed: true,
        }))
    })
    return () => {
      current = false
    }
  }, [api, issue.id, project.id, active, revision, refreshKey, publishUpdated])
  const current = snapshot?.api === api && snapshot?.id === issue.id ? snapshot : undefined
  const error = current?.failed ? (
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
  ) : null
  if (!current?.detail && error) return error
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
