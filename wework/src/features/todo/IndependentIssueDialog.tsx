import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { IndependentIssueProjectPicker } from './IndependentIssueProjectPicker'
import { IndependentIssueTaskButton } from './IndependentIssueTaskButton'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createIndependentIssueDialogState } from './independentIssueDialogState'
import { createPortal } from 'react-dom'
import { Download, X, Maximize2, Minimize2 } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DialogForm } from '@/components/common/DialogForm'
import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import type { TaskIssueShareDraft } from './TaskIssueShare'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { SharedIssueSourceButton } from './SharedIssueSourceButton'
import { IndependentIssueEditor } from './IndependentIssueEditor'

const newIssueFocus = { fallbackSelector: '[data-testid="collaboration-primary-create-issue"]' }

const action =
  'min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8'

type IndependentIssueDialogProps = {
  collaborationApi?: SharedWorkspaceApi
  api: PersonalIssuesApi
  userId: number
  issueId: string | null
  shareDraft?: TaskIssueShareDraft
  onClose(): void
  onSaved(issue: IndependentIssue | null): void
  onOpenProjectIssue?(projectId: string, issueId: string, restricted?: boolean): void
  presentation?: 'dialog' | 'drawer'
  expanded?: boolean
  onExpandedChange?(expanded: boolean): void
}

export function IndependentIssueDialog(props: IndependentIssueDialogProps) {
  const state = useMemo(
    () => createIndependentIssueDialogState(props.api, props.userId, props.issueId),
    [props.api, props.userId, props.issueId]
  )
  return <IndependentIssueDialogContent key={state.key} {...props} state={state} />
}

function IndependentIssueDialogContent({
  state,
  api,
  collaborationApi,
  userId,
  issueId,
  shareDraft,
  onClose,
  onSaved,
  onOpenProjectIssue,
  presentation = 'dialog',
  expanded = false,
  onExpandedChange,
}: IndependentIssueDialogProps & { state: ReturnType<typeof createIndependentIssueDialogState> }) {
  const { t } = useTranslation('common')
  const subscribe = useCallback(
    (listener: () => void) => state.subscribe(listener, { onClose, onSaved, onOpenProjectIssue }),
    [state, onClose, onSaved, onOpenProjectIssue]
  )
  const {
    issue,
    comments,
    loading,
    error,
    errorKind,
    commentError,
    editing,
    busy,
    body,
    associationPending,
  } = useSyncExternalStore(subscribe, state.getSnapshot, state.getSnapshot)
  const conflicted = errorKind === 'conflict'
  const saveUnconfirmed = errorKind === 'unconfirmed'
  const [associating, setAssociating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  const [discarding, setDiscarding] = useState<'close' | 'edit' | 'reload' | null>(null)
  const refreshSavedIssue = state.refreshSavedIssue
  const reloadLatest = () => {
    state.reloadLatest()
    setDirty(false)
  }
  const requestClose = () => {
    if (busy) return
    if (editing && dirty) setDiscarding('close')
    else {
      refreshSavedIssue()
      onClose()
    }
  }
  const ref = useDialogKeyboard<HTMLDivElement>(
    requestClose,
    presentation === 'dialog',
    editing && !issue
      ? '[data-testid="independent-issue-search-people"]'
      : '[data-testid="independent-issue-title"]',
    true,
    !issueId && !shareDraft ? newIssueFocus : undefined
  )
  useEscapeKey(requestClose, presentation === 'drawer' && !deleting && !discarding, ref)
  const name = (id: number | null) =>
    id == null
      ? t('independentIssues.unassigned')
      : id === userId
        ? t('personalHome.me')
        : (issue?.people[id] ?? `#${id}`)
  const content = (
    <>
      <div
        hidden={Boolean(discarding)}
        inert={Boolean(discarding)}
        className={
          discarding
            ? 'hidden'
            : presentation === 'drawer'
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
          className={`flex w-full flex-col overflow-hidden border border-border bg-popover text-text-primary shadow-lg ${presentation === 'drawer' ? 'h-full max-w-none rounded-none border-0 shadow-none' : 'max-h-[calc(100dvh-2rem)] max-w-[800px] rounded-[20px]'} ${presentation === 'dialog' && !issueId && !issue ? '[@media(max-height:740px)]:h-[calc(100dvh-2rem)]' : ''}`}
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3">
            <div className="min-w-0 flex-1">
              {editing && !issue && !loading ? (
                <div ref={setTitleSlot} className="w-full">
                  <h2 id="independent-issue-dialog-title" className="sr-only">
                    {t('independentIssues.create')}
                  </h2>
                </div>
              ) : (
                <h2
                  id="independent-issue-dialog-title"
                  className="truncate text-heading-sm font-medium"
                >
                  {issue?.title ?? t('independentIssues.create')}
                </h2>
              )}
              {(issueId || (shareDraft && issue)) && (
                <p className="mt-1 text-sm text-text-secondary">
                  {t('independentIssues.noProject')}
                </p>
              )}
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
                onClick={requestClose}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>
          <div
            className={
              editing ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'min-h-0 overflow-auto p-5'
            }
          >
            {error || errorKind !== 'default' ? (
              <div
                role="alert"
                className={`mb-4 flex shrink-0 flex-wrap items-center gap-3 text-sm text-destructive ${editing ? 'mx-5 mt-4' : ''}`}
              >
                {associationPending && (
                  <p data-testid="independent-issue-association-pending" className="w-full">
                    {t('issue_creation.association_pending')}
                  </p>
                )}
                <span>
                  {conflicted
                    ? t('issue_creation.conflict_hint')
                    : saveUnconfirmed
                      ? t('issue_creation.save_unconfirmed')
                      : error}
                </span>
                {!editing ? (
                  <button
                    type="button"
                    data-testid="independent-issue-retry"
                    onClick={() => state.retry()}
                    className={action}
                  >
                    {t('independentIssues.retry')}
                  </button>
                ) : conflicted && issue ? (
                  <button
                    type="button"
                    data-testid="independent-issue-reload"
                    onClick={() => (dirty ? setDiscarding('reload') : reloadLatest())}
                    className={action}
                  >
                    {t('issue_creation.reload_latest')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {loading ? (
              <p role="status">{t('independentIssues.loading')}</p>
            ) : editing ? (
              <IndependentIssueEditor
                api={api}
                collaborationApi={collaborationApi}
                allowProjectSelection={!issueId && !(shareDraft && issue)}
                issue={issue}
                shareDraft={issue ? undefined : shareDraft}
                userId={userId}
                busy={busy}
                titleSlot={titleSlot}
                onDirtyChange={setDirty}
                onSave={(input, shareFiles, fileIds) =>
                  state.save(
                    input,
                    !issue && shareDraft
                      ? async (body, projectId, projectStatus) =>
                          api.createShared(
                            shareDraft.requestId,
                            shareDraft.source,
                            body,
                            [
                              ...shareFiles,
                              ...(await Promise.all(
                                shareDraft.conversationFiles
                                  .filter(file => fileIds.includes(file.id))
                                  .map(file =>
                                    file.load().catch(() => {
                                      throw new Error(
                                        t('taskIssueShare.fileUnavailable', { name: file.name })
                                      )
                                    })
                                  )
                              )),
                            ],
                            projectId,
                            projectStatus
                          )
                      : undefined
                  )
                }
                onCancel={() => {
                  if (dirty) setDiscarding(issue ? 'edit' : 'close')
                  else if (issue) {
                    refreshSavedIssue()
                    state.cancelEdit()
                  } else onClose()
                }}
              />
            ) : issue ? (
              <>
                <div className="mb-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="independent-issue-edit"
                    onClick={() => state.beginEdit()}
                    className={action}
                  >
                    {t('independentIssues.edit')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="independent-issue-archive"
                    className={action}
                    onClick={() => void state.toggleArchive()}
                  >
                    {t(
                      issue.metadata.archived
                        ? 'independentIssues.restore'
                        : 'independentIssues.archive'
                    )}
                  </button>
                  {issue.creator_id === userId && issue.metadata.share && (
                    <SharedIssueSourceButton api={api} issueId={issue.id} onOpen={requestClose} />
                  )}
                  <IndependentIssueTaskButton
                    api={api}
                    issue={issue}
                    onError={state.reportTaskError}
                  />
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
                      className={`${action} text-destructive`}
                      onClick={() => {
                        state.clearActionError()
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
                    onConfirm={(projectId, status) => void state.associate(projectId, status)}
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
                {Boolean(issue.metadata.share?.files.length) && (
                  <section className="mt-5 grid gap-2">
                    <h3 className="text-sm font-medium">{t('taskIssueShare.attachments')}</h3>
                    <ul className="grid gap-1" data-testid="independent-issue-attachments">
                      {issue.metadata.share?.files.map(file => (
                        <li key={file.id}>
                          <button
                            type="button"
                            className={action + ' inline-flex max-w-full items-center gap-2'}
                            data-testid={`independent-issue-attachment-${file.id}`}
                            onClick={() => {
                              void api
                                .sharedAttachment(issue.id, file.id)
                                .then(blob => saveBlobToDownloads(blob, file.filename))
                                .catch(error => state.reportTaskError(String(error)))
                            }}
                          >
                            <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="truncate">{file.filename}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <h3 className="mb-3 mt-7 text-base font-medium">
                  {t('independentIssues.discussion')}
                </h3>
                {commentError ? (
                  <p role="alert" className="mb-3 text-sm text-destructive">
                    {commentError}
                    <button
                      type="button"
                      data-testid="independent-issue-comments-retry"
                      className={action}
                      onClick={() => state.retry()}
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
                    void state.sendComment()
                  }}
                >
                  <label className="grid gap-2 text-sm">
                    {t('independentIssues.comment')}
                    <textarea
                      data-testid="independent-issue-comment"
                      disabled={busy}
                      value={body}
                      onChange={event => state.editComment(event.target.value)}
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
        open={Boolean(discarding)}
        title={t(
          discarding === 'reload'
            ? 'issue_creation.reload_latest'
            : saveUnconfirmed
              ? 'issue_creation.unconfirmed_discard_title'
              : 'issue_creation.discard_title'
        )}
        description={t(
          discarding === 'reload'
            ? 'issue_creation.reload_hint'
            : associationPending
              ? 'issue_creation.saved_issue_discard_hint'
              : saveUnconfirmed
                ? 'issue_creation.unconfirmed_discard_hint'
                : 'issue_creation.discard_hint'
        )}
        cancelLabel={t('issue_creation.keep_editing')}
        confirmLabel={t(
          discarding === 'reload' ? 'issue_creation.reload_confirm' : 'issue_creation.discard'
        )}
        confirmTestId="independent-issue-discard-confirm"
        dialogTestId="independent-issue-discard-dialog"
        destructive
        onClose={() => setDiscarding(null)}
        onConfirm={() => {
          const action = discarding
          setDiscarding(null)
          if (action === 'reload') {
            reloadLatest()
            return
          }
          refreshSavedIssue()
          if (action === 'edit') state.cancelEdit()
          else {
            onClose()
          }
        }}
      />
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
          void state.remove().then(removed => {
            if (removed && state.isOwned()) setDeleting(false)
          })
        }
      />
    </>
  )
  return presentation === 'drawer' ? content : createPortal(content, document.body)
}
