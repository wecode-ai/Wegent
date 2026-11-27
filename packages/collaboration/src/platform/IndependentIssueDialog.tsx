import { Button as ControlButton } from '../markdown/Button'
import type { SharedWorkspaceApi, SharedWorkspaceAttachmentsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import { IndependentIssueProjectPicker } from './IndependentIssueProjectPicker'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createIndependentIssueDialogState } from './independentIssueDialogState'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { usePersonalIssueTranslation } from './personalIssueMessages'
import { DialogSurface } from '../controls/DialogSurface'
import { ConfirmDialog } from './ConfirmDialog'
import type { IndependentIssue, PersonalIssuesApi, TaskIssueShareDraft } from './personalIssuesApi'
import { IndependentIssueEditor, type IssueShareFiles } from './IndependentIssueEditor'
import { groupIssueTimelineThreads, IssueActivityThread } from '../issue-detail/IssueActivityThread'
import { IssueChatMessage } from '../issue-detail/IssueChatMessage'
import {
  collapsedIssueActivity,
  issueActivityTimeline,
} from '../issue-detail/issueActivityTimeline'
import { IssueWebCommentComposer } from '../issue-detail/IssueWebCommentComposer'
import {
  toSharedIssueDetailTaskBinding,
  type SharedIssueDetailTaskBinding,
} from '../issue-detail/createSharedIssueDetailPort'
import type { TodoEditorProps } from '../issue-detail/issueEditorSupport'
import type { SharedIssueDetailExtensions } from '../SharedIssueDetailEditor'
import { useCollaborationPortalTheme } from '../theme'
import { SharedIssueDetailEditor } from '../SharedIssueDetailEditor'
import { IssueActivityFeed } from '../issue-detail/IssueActivityFeed'
import { IssueActivityTimelineRows } from '../issue-detail/IssueActivityTimelineRows'
import { IssueConversationDrawers } from '../issue-detail/IssueConversationDrawers'
import { createIndependentIssueDetailPort } from './independentIssueDetailPort'

const newIssueFocus = {
  fallbackSelector: '[data-testid="collaboration-primary-create-issue"]',
}

const action =
  'min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8'

export type IndependentIssueDialogProps = {
  collaborationApi?: SharedWorkspaceApi
  attachments?: SharedWorkspaceAttachmentsApi
  commentSendKey?: 'enter' | 'cmd_enter'
  api: PersonalIssuesApi<CollaborationProject>
  userId: number
  issueId: string | null
  shareDraft?: TaskIssueShareDraft
  onClose(): void
  onSaved(issue: IndependentIssue | null): void
  onOpenChildTask?: TodoEditorProps['onOpenChildTask']
  onOpenProjectIssue?(projectId: string, issueId: string, restricted?: boolean): void
  onMovedToProject?(projectId: string, issueId: string): void
  presentation?: 'dialog' | 'embedded'
  expanded?: boolean
  onExpandedChange?(expanded: boolean): void
  onConversationOpenChange?(open: boolean): void
  renderDescriptionEditor?: SharedIssueDetailExtensions['renderDescriptionEditor']
  translateIssueDetail?(
    key: string,
    fallback?: string,
    options?: Record<string, string | number>
  ): string
  ShareFiles?: IssueShareFiles
  renderExecutionSettings?(projectId: string, busy: boolean): ReactNode
  taskActions?: {
    list?: SharedWorkspaceApi['taskBindings']['list']
    link(issue: IndependentIssue, refresh: () => void): TodoEditorProps['linkedTaskAction']
    renderConversation(
      issue: IndependentIssue,
      task: SharedIssueDetailTaskBinding | null,
      close: () => void,
      refresh: () => void
    ): ReactNode
  }
  renderSourceAction?(issueId: string, onOpen: () => void): ReactNode
  saveAttachment(blob: Blob, filename: string): Promise<unknown>
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
  attachments,
  commentSendKey,
  userId,
  issueId,
  shareDraft,
  onClose,
  onSaved,
  onOpenChildTask,
  onOpenProjectIssue,
  onMovedToProject,
  presentation = 'dialog',
  expanded = false,
  onExpandedChange,
  onConversationOpenChange,
  ShareFiles,
  renderExecutionSettings,
  renderDescriptionEditor,
  translateIssueDetail,
  taskActions,
  renderSourceAction,
  saveAttachment,
}: IndependentIssueDialogProps & {
  state: ReturnType<typeof createIndependentIssueDialogState>
}) {
  const t = usePersonalIssueTranslation()
  const portalTheme = useCollaborationPortalTheme()
  const subscribe = useCallback(
    (listener: () => void) =>
      state.subscribe(listener, {
        onClose,
        onSaved,
        onOpenProjectIssue,
        onMovedToProject,
      }),
    [state, onClose, onSaved, onOpenProjectIssue, onMovedToProject]
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
    associationPending,
  } = useSyncExternalStore(subscribe, state.getSnapshot, state.getSnapshot)
  const conflicted = errorKind === 'conflict'
  const saveUnconfirmed = errorKind === 'unconfirmed'
  const [associating, setAssociating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dirty, setDirty] = useState(Boolean(shareDraft?.selectedExcerpt))
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null)
  const [discarding, setDiscarding] = useState<'close' | 'edit' | 'reload' | null>(null)
  const refreshSavedIssue = state.refreshSavedIssue
  const reloadLatest = () => {
    state.reloadLatest()
    setDirty(false)
  }
  const canClose = () => {
    if (busy) return false
    if (!editing || !dirty) return true
    setDiscarding('close')
    return false
  }
  const finishClose = () => {
    refreshSavedIssue()
    onClose()
  }
  const requestClose = () => {
    if (canClose()) finishClose()
  }
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement)
  const discardClosesEditor = useRef(false)
  const attachmentRequestId = useRef<string | undefined>(undefined)
  const restoreCreateFocus = !issueId && !shareDraft
  const getCreateOpener = () =>
    opener.current instanceof HTMLElement &&
    opener.current !== document.body &&
    opener.current.isConnected
      ? opener.current
      : document.querySelector<HTMLElement>(newIssueFocus.fallbackSelector)
  const overlayDrawer =
    presentation === 'dialog' && Boolean(issueId || (issue && !associationPending))
  const modal = presentation === 'dialog' && !overlayDrawer
  const [taskRevision, setTaskRevision] = useState(0)
  const [expandedActivity, setExpandedActivity] = useState(false)
  const [conversation, setConversation] = useState<{
    task: SharedIssueDetailTaskBinding | null
  }>()
  const refreshTaskBindings = () => setTaskRevision(value => value + 1)
  const openTaskConversation = (task: SharedIssueDetailTaskBinding | null) => {
    setConversation({ task })
    onConversationOpenChange?.(true)
  }
  const closeConversation = () => {
    setConversation(undefined)
    onConversationOpenChange?.(false)
  }
  const listTaskBindings = collaborationApi?.taskBindings.list ?? taskActions?.list
  const attachmentApi = attachments ?? collaborationApi?.attachments
  const canManageParticipants = issue?.creator_id === userId
  const detailPort = useMemo(
    () =>
      createIndependentIssueDetailPort(
        state,
        api,
        saveAttachment,
        listTaskBindings
          ? async id => (await listTaskBindings(id)).map(toSharedIssueDetailTaskBinding)
          : undefined,
        attachmentApi,
        canManageParticipants
      ),
    [state, api, saveAttachment, listTaskBindings, attachmentApi, canManageParticipants]
  )
  const reading = Boolean(issue?.detail && !loading && !editing)
  const cancelEditing = () => {
    if (busy) return
    if (dirty) setDiscarding(issue ? 'edit' : 'close')
    else if (issue) {
      refreshSavedIssue()
      state.cancelEdit()
    } else onClose()
  }
  const translateDetail = (
    key: string,
    fallback?: string,
    options?: Record<string, string | number>
  ) => {
    if (translateIssueDetail && (key.startsWith('todo.') || key.startsWith('activity.'))) {
      return translateIssueDetail(key, fallback, options)
    }
    const translated = t(key, options)
    return translated === key ? (fallback ?? key) : translated
  }
  const name = (id: number | null) =>
    id == null
      ? t('independentIssues.unassigned')
      : id === userId
        ? t('personalHome.me')
        : (issue?.people[id] ?? `#${id}`)
  const panelActions = (
    <div className="flex shrink-0 gap-1">
      <ControlButton
        variant="unstyled"
        type="button"
        disabled={busy}
        data-testid="independent-issue-close"
        aria-label={t('independentIssues.close')}
        onClick={requestClose}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
      >
        <X className="h-4 w-4" />
      </ControlButton>
    </div>
  )
  const activity = useMemo(
    () =>
      issue
        ? issueActivityTimeline({
            cards: groupIssueTimelineThreads(comments),
            enabled: true,
            createdAt: issue.created_at,
            statusHistory: issue.metadata.status_history ?? [],
            assignmentHistory: issue.detail?.assignment_history ?? [],
          })
        : [],
    [issue, comments]
  )
  const visibleActivity = useMemo(
    () => collapsedIssueActivity(activity, expandedActivity),
    [activity, expandedActivity]
  )
  const content = (
    <>
      <div
        {...(modal ? portalTheme : undefined)}
        hidden={Boolean(discarding)}
        inert={Boolean(discarding)}
        className={
          discarding
            ? 'hidden'
            : modal
              ? `${portalTheme.className} fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4`
              : 'relative flex h-full min-h-0 min-w-0 w-full'
        }
      >
        <DialogSurface
          onClose={requestClose}
          active={modal}
          suspended={Boolean(discarding || deleting)}
          initialFocus={
            reading
              ? '[data-testid="independent-issue-close"]'
              : editing && !issue
                ? '[data-testid="independent-issue-search-people"]'
                : '[data-testid="independent-issue-title"]'
          }
          finalFocus={restoreCreateFocus ? getCreateOpener : undefined}
          render={
            <div
              ref={ref}
              role={modal ? 'dialog' : 'region'}
              aria-modal={modal ? true : undefined}
              aria-label={reading ? issue?.title : undefined}
              aria-labelledby={reading ? undefined : 'independent-issue-dialog-title'}
              inert={deleting}
              data-testid="independent-issue-dialog"
              className={`flex w-full flex-col overflow-hidden border border-border bg-popover text-text-primary shadow-lg ${modal ? 'max-h-[calc(100dvh-2rem)] max-w-[800px] rounded-[20px]' : 'h-full max-w-none rounded-none border-0 shadow-none'} ${modal && !issueId && !issue ? 'min-h-[min(480px,calc(100dvh-2rem))]' : ''}`}
            />
          }
        >
          {!reading && (
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
                    className="break-words text-heading-sm font-medium md:truncate"
                    title={issue?.title}
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
              {panelActions}
            </header>
          )}
          <div
            className={
              editing || reading
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                : 'min-h-0 overflow-auto p-5'
            }
          >
            {error || errorKind !== 'default' ? (
              <div
                role="alert"
                className={`mb-4 flex shrink-0 flex-wrap items-center gap-3 text-sm text-destructive ${editing || reading ? 'mx-5 mt-4' : ''}`}
              >
                {associationPending && (
                  <p data-testid="independent-issue-association-pending" className="w-full">
                    {t('issue_creation.association_pending')}
                  </p>
                )}
                <span>
                  {conflicted
                    ? t('issue_creation.conflict_hint')
                    : errorKind === 'saved-detail'
                      ? t('issue_creation.saved_detail_unavailable')
                      : saveUnconfirmed
                        ? t('issue_creation.save_unconfirmed')
                        : error}
                </span>
                {!editing ? (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="independent-issue-retry"
                    onClick={() => state.retry()}
                    className={action}
                  >
                    {t('independentIssues.retry')}
                  </ControlButton>
                ) : conflicted && issue ? (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="independent-issue-reload"
                    onClick={() => (dirty ? setDiscarding('reload') : reloadLatest())}
                    className={action}
                  >
                    {t('issue_creation.reload_latest')}
                  </ControlButton>
                ) : null}
              </div>
            ) : null}
            {loading ? (
              <p role="status">{t('independentIssues.loading')}</p>
            ) : editing ? (
              <IndependentIssueEditor
                api={api}
                ShareFiles={ShareFiles}
                renderExecutionSettings={renderExecutionSettings}
                collaborationApi={collaborationApi}
                allowProjectSelection={!issueId && !(shareDraft && issue)}
                issue={issue}
                shareDraft={issue ? undefined : shareDraft}
                userId={userId}
                busy={busy}
                titleSlot={titleSlot}
                onDirtyChange={setDirty}
                onCancel={cancelEditing}
                onSave={(input, shareFiles, fileIds) => {
                  if (!issue && !shareDraft && shareFiles.length && !attachmentRequestId.current) {
                    attachmentRequestId.current = crypto.randomUUID()
                  }
                  const requestId = shareDraft?.requestId ?? attachmentRequestId.current
                  return state.save(
                    input,
                    !issue && requestId
                      ? async (body, projectId, projectStatus) =>
                          api.createShared(
                            requestId,
                            shareDraft?.source,
                            body,
                            [
                              ...shareFiles,
                              ...(await Promise.all(
                                (shareDraft?.conversationFiles ?? [])
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
                }}
              />
            ) : issue?.detail ? (
              <SharedIssueDetailEditor
                key={issue.id}
                mode="edit"
                item={issue.detail}
                allItems={issue.detail.related_issues ?? []}
                port={detailPort}
                editable
                taskRefreshKey={`${issue.version}:${taskRevision}`}
                canAssign
                currentUserId={userId}
                presentation="workspace-panel"
                workspacePanelFill
                readFirst
                showChildren={false}
                linkedTaskAction={taskActions?.link(issue, refreshTaskBindings)}
                onCreateTask={taskActions ? () => openTaskConversation(null) : undefined}
                onOpenTaskConversation={taskActions ? openTaskConversation : undefined}
                onOpenChildTask={onOpenChildTask}
                translate={translateDetail}
                onUpdated={() => {}}
                onClose={requestClose}
                showFullscreenControl={false}
                closeTestId="independent-issue-close"
                closeDisabled={busy}
                panelExpansion={
                  onExpandedChange
                    ? {
                        expanded,
                        onChange: onExpandedChange,
                        testId: 'independent-issue-expand',
                      }
                    : undefined
                }
                headerActions={
                  issue.creator_id === userId && issue.metadata.share
                    ? renderSourceAction?.(issue.id, requestClose)
                    : undefined
                }
                issueActionsTestId="independent-issue-actions"
                issueActions={[
                  {
                    id: 'independent-issue-edit',
                    label: t('independentIssues.edit'),
                    onSelect: () => {
                      setDirty(false)
                      state.beginEdit()
                    },
                    disabled: busy,
                  },
                  {
                    id: 'independent-issue-archive',
                    label: t(
                      issue.metadata.archived
                        ? 'independentIssues.restore'
                        : 'independentIssues.archive'
                    ),
                    onSelect: () => void state.toggleArchive(),
                    disabled: busy,
                  },
                  ...(issue.creator_id === userId && onOpenProjectIssue
                    ? [
                        {
                          id: 'independent-issue-associate',
                          label: t('independentIssues.attachProject'),
                          onSelect: () => setAssociating(true),
                          disabled: busy,
                        },
                      ]
                    : []),
                  ...(issue.creator_id === userId
                    ? [
                        {
                          id: 'independent-issue-delete',
                          label: t('independentIssues.delete'),
                          onSelect: () => {
                            state.clearActionError()
                            setDeleting(true)
                          },
                          destructive: true,
                          disabled: busy,
                        },
                      ]
                    : []),
                ]}
                detailActions={
                  <>
                    {associating && onOpenProjectIssue ? (
                      <IndependentIssueProjectPicker
                        api={api}
                        issue={issue}
                        busy={busy}
                        onCancel={() => setAssociating(false)}
                        onConfirm={(projectId, status) => void state.associate(projectId, status)}
                      />
                    ) : null}
                  </>
                }
                extensions={{
                  renderDescriptionEditor,
                  renderActivity: ({ commentActions, commentAssignment, members, agents }) => (
                    <IssueActivityFeed
                      testId="independent-issue-activity"
                      listTestId="independent-issue-activity-list"
                      translate={translateDetail}
                      count={activity.length}
                      loading={false}
                      emptyDescription={translateDetail('activity.task_activity_empty_without_ai')}
                      tools={
                        commentError ? (
                          <p role="alert" className="mb-3 text-sm text-destructive">
                            {commentError}
                            <ControlButton
                              variant="unstyled"
                              type="button"
                              data-testid="independent-issue-comments-retry"
                              className={action}
                              onClick={() => state.retry()}
                            >
                              {t('independentIssues.retry')}
                            </ControlButton>
                          </p>
                        ) : null
                      }
                      composer={
                        <IssueWebCommentComposer
                          issueId={issue.id}
                          issueActions={commentActions}
                          assignment={commentAssignment}
                          attachmentApi={attachmentApi}
                          canComment={!busy}
                          canAttach={Boolean(attachmentApi)}
                          loading={false}
                          members={members}
                          agents={agents}
                          translate={translateDetail}
                          sendKey={commentSendKey}
                          send={async (message, mentions) => {
                            const users = (mentions ?? [])
                              .filter(mention => mention.type === 'user')
                              .map(mention => Number(mention.id))
                            if (!(await state.sendComment(message, users))) {
                              throw new Error(
                                state.getSnapshot().error || translateDetail('todo.send_failed')
                              )
                            }
                            refreshTaskBindings()
                          }}
                          onSent={() => {}}
                          onError={() => {}}
                          testIds={{
                            form: 'task-comment-form',
                            input: 'independent-issue-comment',
                            send: 'independent-issue-comment-send',
                            settings: 'task-comment-settings-toggle',
                            file: 'task-comment-file-input',
                            attach: 'task-comment-attach',
                          }}
                        />
                      }
                    >
                      <IssueActivityTimelineRows
                        rows={visibleActivity}
                        creator={issue.people[issue.creator_id] ?? name(issue.creator_id)}
                        memberName={id => (id === null ? null : (issue.people[id] ?? name(id)))}
                        translate={translateDetail}
                        expandLabel={count => t('personalHome.expandActivity', { count })}
                        onExpand={() => setExpandedActivity(true)}
                        renderComment={thread => (
                          <IssueActivityThread
                            thread={thread}
                            variant="timeline"
                            renderMessage={message => (
                              <IssueChatMessage
                                key={message.messageId}
                                message={message}
                                mine={
                                  message.sender.type === 'user' &&
                                  message.sender.id === String(userId)
                                }
                                compact
                                plain
                                allowBackendExecutionFallback={false}
                                translate={translateDetail}
                                onOpenUrl={url => {
                                  window.open(url, '_blank', 'noopener,noreferrer')
                                }}
                              />
                            )}
                          />
                        )}
                      />
                    </IssueActivityFeed>
                  ),
                }}
              />
            ) : null}
          </div>
        </DialogSurface>
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
        finalFocus={
          restoreCreateFocus
            ? () => (discardClosesEditor.current ? getCreateOpener() : null)
            : undefined
        }
        onClose={() => setDiscarding(null)}
        onConfirm={() => {
          const action = discarding
          discardClosesEditor.current = action === 'close'
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
  if (modal) return createPortal(content, document.body)
  const drawer = (
    <div className="issue-drawer-workspace h-full min-h-0 w-full">
      <IssueConversationDrawers
        embedded={!overlayDrawer}
        label={issue?.title ?? t('independentIssues.noProject')}
        conversation={
          issue && conversation
            ? taskActions?.renderConversation(
                issue,
                conversation.task,
                closeConversation,
                refreshTaskBindings
              )
            : null
        }
        conversationKey={conversation?.task?.id ?? (conversation ? 'new-task' : undefined)}
        canClose={() => !deleting && !discarding && canClose()}
        onClose={finishClose}
        onCloseConversation={closeConversation}
      >
        {() => content}
      </IssueConversationDrawers>
    </div>
  )
  return overlayDrawer
    ? createPortal(
        <div {...portalTheme} className={`${portalTheme.className} fixed inset-0 z-modal`}>
          {drawer}
        </div>,
        document.body
      )
    : drawer
}
