import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { ApiError } from '@/api/http'
import { IndependentIssueProjectPicker } from './IndependentIssueProjectPicker'
import { IndependentIssueTaskButton } from './IndependentIssueTaskButton'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Maximize2, Minimize2 } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DialogForm } from '@/components/common/DialogForm'
import {
  independentIssueInput,
  type IndependentIssue,
  type IndependentIssueComment,
  type PersonalIssuesApi,
} from '@/api/personalIssues'
import { IndependentIssueEditor, type IssueCreationInput } from './IndependentIssueEditor'

const action =
  'min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8'

export function IndependentIssueDialog({
  api,
  collaborationApi,
  userId,
  issueId,
  onClose,
  onSaved,
  onOpenProjectIssue,
  presentation = 'dialog',
  expanded = false,
  onExpandedChange,
}: {
  collaborationApi?: SharedWorkspaceApi
  api: PersonalIssuesApi
  userId: number
  issueId: string | null
  onClose(): void
  onSaved(issue: IndependentIssue | null): void
  onOpenProjectIssue?(projectId: string, issueId: string): void
  presentation?: 'dialog' | 'drawer'
  expanded?: boolean
  onExpandedChange?(expanded: boolean): void
}) {
  const { t } = useTranslation('common')
  const [issue, setIssue] = useState<IndependentIssue | null>(null)
  const [comments, setComments] = useState<IndependentIssueComment[]>([])
  const [loading, setLoading] = useState(Boolean(issueId))
  const [error, setError] = useState('')
  const [commentError, setCommentError] = useState('')
  const [editing, setEditing] = useState(!issueId)
  const [busy, setBusy] = useState(false)
  const [associating, setAssociating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [body, setBody] = useState('')
  const [retry, setRetry] = useState(0)
  const ref = useDialogKeyboard<HTMLDivElement>(
    () => {
      if (!busy) onClose()
    },
    presentation === 'dialog' && !deleting,
    'input, button'
  )
  useEscapeKey(
    () => {
      if (!busy) onClose()
    },
    presentation === 'drawer' && !deleting,
    ref
  )
  useEffect(() => {
    if (!issueId) return
    let active = true
    void api
      .get(issueId)
      .then(
        row => {
          if (active) {
            setIssue(row)
            setError('')
          }
        },
        reason => {
          if (active) {
            setError(reason instanceof Error ? reason.message : String(reason))
            if (reason instanceof ApiError && [403, 404].includes(reason.status)) {
              setIssue(null)
              setComments([])
              setEditing(false)
            }
          }
        }
      )
      .finally(() => {
        if (active) setLoading(false)
      })
    void api.comments(issueId).then(
      rows => {
        if (active) {
          setComments(rows)
          setCommentError('')
        }
      },
      reason => {
        if (active) setCommentError(reason instanceof Error ? reason.message : String(reason))
      }
    )
    return () => {
      active = false
    }
  }, [api, issueId, retry])
  const run = async (operation: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  const save = ({ project_id, project_status, ...input }: IssueCreationInput) =>
    run(async () => {
      const row = issue ? await api.update(issue.id, input) : await api.create(input)
      setIssue(row)
      if (project_id) {
        const target = await api.associate(row.id, project_id, row.version, project_status ?? '')
        onSaved(null)
        onOpenProjectIssue?.(target.project_id, target.issue_id)
        onClose()
        return
      }
      setEditing(false)
      onSaved(row)
    })
  const sendComment = () =>
    run(async () => {
      if (!issue || !body.trim()) return
      await api.comment(issue.id, body.trim())
      setBody('')
      const row = await api.get(issue.id)
      setIssue(row)
      onSaved(row)
      try {
        setComments(await api.comments(issue.id))
        setCommentError('')
      } catch (reason) {
        setCommentError(reason instanceof Error ? reason.message : String(reason))
      }
    })
  const name = (id: number | null) =>
    id == null
      ? t('independentIssues.unassigned')
      : id === userId
        ? t('personalHome.me')
        : (issue?.people[id] ?? `#${id}`)
  const content = (
    <>
      <div
        className={
          presentation === 'drawer'
            ? `relative flex h-full min-h-0 min-w-0 shrink-0 border-l border-border ${expanded ? 'w-[min(75%,72rem)]' : 'w-[min(44%,32rem)]'}`
            : 'fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4'
        }
      >
        <div
          ref={ref}
          role={presentation === 'drawer' ? 'region' : 'dialog'}
          aria-modal={presentation === 'dialog' ? true : undefined}
          aria-labelledby="independent-issue-dialog-title"
          inert={deleting}
          data-testid="independent-issue-dialog"
          className={`flex w-full max-w-3xl flex-col border border-border bg-popover text-text-primary shadow-lg ${presentation === 'drawer' ? 'h-full max-w-none rounded-none border-0 shadow-none' : 'max-h-[calc(100dvh-2rem)] rounded-xl'}`}
        >
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
            <div>
              <h2 id="independent-issue-dialog-title" className="text-heading-sm font-medium">
                {issue?.title ?? t('independentIssues.create')}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                {t(!issueId ? 'issue_creation.generic_scope_hint' : 'independentIssues.noProject')}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              {presentation === 'drawer' && onExpandedChange && (
                <button
                  type="button"
                  data-testid="independent-issue-expand"
                  aria-pressed={expanded}
                  aria-label={t(
                    expanded
                      ? 'workbench.restore_right_workspace_panel'
                      : 'workbench.expand_right_workspace_panel'
                  )}
                  onClick={() => onExpandedChange(!expanded)}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
                >
                  {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                data-testid="independent-issue-close"
                aria-label={t('independentIssues.close')}
                onClick={onClose}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>
          <div className="min-h-0 overflow-auto p-5">
            {error ? (
              <div
                role="alert"
                className="mb-4 flex flex-wrap items-center gap-3 text-sm text-error"
              >
                <span>{error}</span>
                {!editing ? (
                  <button
                    type="button"
                    data-testid="independent-issue-retry"
                    onClick={() => setRetry(value => value + 1)}
                    className={action}
                  >
                    {t('independentIssues.retry')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {loading && !issue ? (
              <p role="status">{t('independentIssues.loading')}</p>
            ) : editing ? (
              <IndependentIssueEditor
                api={api}
                collaborationApi={collaborationApi}
                allowProjectSelection={!issueId}
                issue={issue}
                userId={userId}
                busy={busy}
                onSave={save}
                onCancel={() => (issue ? setEditing(false) : onClose())}
              />
            ) : issue ? (
              <>
                <div className="mb-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="independent-issue-edit"
                    onClick={() => setEditing(true)}
                    className={action}
                  >
                    {t('independentIssues.edit')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="independent-issue-archive"
                    className={action}
                    onClick={() =>
                      void run(async () => {
                        const row = await api.update(issue.id, {
                          ...independentIssueInput(issue),
                          archived: !issue.metadata.archived,
                        })
                        setIssue(row)
                        onSaved(row)
                      })
                    }
                  >
                    {t(
                      issue.metadata.archived
                        ? 'independentIssues.restore'
                        : 'independentIssues.archive'
                    )}
                  </button>
                  <IndependentIssueTaskButton api={api} issue={issue} onError={setError} />
                  {issue.creator_id === userId && onOpenProjectIssue ? (
                    <button
                      type="button"
                      disabled={busy}
                      data-testid="independent-issue-associate"
                      onClick={() => setAssociating(value => !value)}
                      className={action}
                    >
                      {t('independentIssues.attachProject')}
                    </button>
                  ) : null}
                  {issue.creator_id === userId ? (
                    <button
                      type="button"
                      disabled={busy}
                      data-testid="independent-issue-delete"
                      className={`${action} text-error`}
                      onClick={() => {
                        setError('')
                        setDeleting(true)
                      }}
                    >
                      {t('independentIssues.delete')}
                    </button>
                  ) : null}
                </div>
                {associating && onOpenProjectIssue ? (
                  <IndependentIssueProjectPicker
                    api={api}
                    issue={issue}
                    busy={busy}
                    onCancel={() => setAssociating(false)}
                    onConfirm={(projectId, status) =>
                      void run(async () => {
                        const linked = await api.associate(
                          issue.id,
                          projectId,
                          issue.version,
                          status
                        )
                        onSaved(null)
                        onOpenProjectIssue(linked.project_id, linked.issue_id)
                      })
                    }
                  />
                ) : null}
                <dl className="mb-5 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-text-secondary">{t('independentIssues.status')}</dt>
                    <dd>{t(`independentIssues.${issue.status}`)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t('independentIssues.assignee')}</dt>
                    <dd>
                      {issue.metadata.resource_participants?.find(
                        resource =>
                          resource.kind === issue.metadata.assignee_resource?.kind &&
                          resource.id === issue.metadata.assignee_resource?.id
                      )?.name ?? name(issue.assignee_id)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t('independentIssues.priority')}</dt>
                    <dd>{t(`independentIssues.${issue.priority}`)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t('independentIssues.due')}</dt>
                    <dd>{issue.metadata.due_at ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t('independentIssues.creator')}</dt>
                    <dd>{name(issue.creator_id)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">{t('independentIssues.participants')}</dt>
                    <dd>
                      {[
                        ...issue.metadata.participants.map(name),
                        ...(issue.metadata.resource_participants ?? []).map(
                          resource => resource.name
                        ),
                      ].join('、') || t('independentIssues.creatorOnly')}
                    </dd>
                  </div>
                </dl>
                <div className="whitespace-pre-wrap break-words text-base leading-7">
                  {issue.description}
                </div>
                <h3 className="mb-3 mt-7 text-base font-medium">
                  {t('independentIssues.discussion')}
                </h3>
                {commentError ? (
                  <p role="alert" className="mb-3 text-sm text-error">
                    {commentError}
                    <button
                      type="button"
                      data-testid="independent-issue-comments-retry"
                      className={action}
                      onClick={() => setRetry(value => value + 1)}
                    >
                      {t('independentIssues.retry')}
                    </button>
                  </p>
                ) : null}
                {comments.map(comment => (
                  <article key={comment.id} className="border-t border-border py-4">
                    <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
                      <span>{name(comment.author_id)}</span>
                      <time>{comment.created_at}</time>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{comment.body}</p>
                  </article>
                ))}
                <DialogForm
                  className="mt-4 grid gap-2"
                  onSubmit={event => {
                    event.preventDefault()
                    void sendComment()
                  }}
                >
                  <label className="grid gap-2 text-sm">
                    {t('independentIssues.comment')}
                    <textarea
                      data-testid="independent-issue-comment"
                      disabled={busy}
                      value={body}
                      onChange={event => setBody(event.target.value)}
                      rows={3}
                      className="rounded-md border border-border bg-background p-3"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy || !body.trim()}
                    data-testid="independent-issue-comment-send"
                    className={`${action} justify-self-end`}
                  >
                    {t('independentIssues.send')}
                  </button>
                </DialogForm>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={deleting}
        title={t('independentIssues.delete')}
        description={`${t('independentIssues.deleteHint')}${error ? ` ${error}` : ''}`}
        cancelLabel={t('independentIssues.cancel')}
        confirmLabel={t('independentIssues.confirmDelete')}
        confirmTestId="independent-issue-confirm-delete"
        destructive
        pending={busy}
        onClose={() => {
          if (!busy) setDeleting(false)
        }}
        onConfirm={() =>
          void run(async () => {
            if (!issue) return
            await api.remove(issue.id, issue.version)
            setDeleting(false)
            onSaved(null)
          })
        }
      />
    </>
  )
  return presentation === 'drawer' ? content : createPortal(content, document.body)
}
