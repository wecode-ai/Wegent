import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ArrowLeft, Hash, Info } from 'lucide-react'
import {
  createCollaborationTranslator,
  formatIssueTimestamp,
  useIssueProjectChat,
  type CollaborationIssue,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { ActionMenu } from '@wegent/collaboration/controls'
import type { ProjectChatClient } from '@wegent/chat-core'
import type {
  ChatGroup,
  ChatGroupApi,
  ChatGroupMember,
  ThreadParticipation,
} from '@/api/chatGroups'
import type { DeviceCommandApi } from '@/api/environment'
import { Button } from '@/components/ui/button'
import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'
import { useTranslation } from '@/hooks/useTranslation'
import { ThreadSettings } from './ThreadSettings'
import { GroupMessageComposer } from './GroupMessageComposer'
import { GroupChatMessage } from './GroupChatMessage'
import { ThreadExecutionActivity } from './ThreadExecutionActivity'
import { createGroupReplyTarget, type GroupReplyTarget } from './groupReply'
import { ThreadHierarchySection } from './ThreadHierarchySection'
import { threadLifecycleLabel } from './threadLifecycle'
import type { ThreadActionContext } from './threadActions'
import { useFocusedComment } from '@/features/todo/useFocusedComment'
import { useThreadContentRead } from './useThreadContentRead'
import { useThreadAgentCandidates } from './useThreadAgentCandidates'
import { useThreadCommentExecution } from './useThreadCommentExecution'
import { threadCommentRequestsExecution } from './threadCommentExecution'

export function GroupConversation({
  group,
  project,
  item,
  items,
  api,
  catalog,
  members,
  groups,
  chat,
  locale,
  onOpenThread,
  onOpenRelatedThread = onOpenThread,
  onCreateChild,
  onArchiveThread,
  accountScope,
  renderThreadActions,
  onThreadActionContext,
  requestLeave,
  changeRequestApi,
  onBack,
  onBackToBoard,
  onChanged,
  registerLeaveGuard,
  focusedCommentId = null,
  focusRequestKey = null,
  onClearFocus,
  active = true,
}: {
  group: ChatGroup
  project: CollaborationProject
  item: CollaborationIssue | null
  items: CollaborationIssue[]
  api: SharedWorkspaceApi
  catalog: SharedWorkspaceApi
  members: ChatGroupMember[]
  groups: ChatGroupApi
  chat: ProjectChatClient | undefined
  locale: 'zh-CN' | 'en'
  onOpenThread(id: string): void
  onOpenRelatedThread?(id: string): void
  onCreateChild?(parent: CollaborationIssue, project?: CollaborationProject): void
  onArchiveThread?(item: CollaborationIssue): void
  accountScope?: string
  renderThreadActions?(context: ThreadActionContext): ReactNode
  onThreadActionContext?(context: ThreadActionContext | null): void
  requestLeave?(action: () => void): void
  changeRequestApi?: DeviceCommandApi
  onBack(): void
  onBackToBoard?(): void
  onChanged(): void
  registerLeaveGuard?(guard: ((action: () => void) => void) | null): void
  focusedCommentId?: string | null
  focusRequestKey?: string | null
  onClearFocus(): void
  active?: boolean
}) {
  const { t } = useTranslation('collaboration')
  const [participationState, setParticipationState] = useState<{
    threadId: string
    value: ThreadParticipation
  } | null>(null)
  const participation =
    participationState && participationState.threadId === item?.id ? participationState.value : null
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const requestWorkAction = useCallback(
    (action: () => void, leave = requestLeave) =>
      leave?.(() => {
        setEditing(false)
        action()
      }),
    [requestLeave]
  )
  const conversationScope = JSON.stringify([
    accountScope,
    project.project_store,
    group.id,
    item?.id,
  ])
  const [replyTarget, setReplyTarget] = useState<GroupReplyTarget | null>(null)
  if (replyTarget && replyTarget.scopeKey !== conversationScope) setReplyTarget(null)
  const [historyState, setHistoryState] = useState<{
    owner: string | null
    page?: { beforeSequence?: number; afterSequence?: number }
  }>({ owner: focusRequestKey })
  if (historyState.owner !== focusRequestKey) setHistoryState({ owner: focusRequestKey })
  const historyPage = historyState.owner === focusRequestKey ? historyState.page : undefined
  const contextListener = useRef(onThreadActionContext)
  useLayoutEffect(() => {
    contextListener.current = onThreadActionContext
  }, [onThreadActionContext])
  useEffect(() => () => contextListener.current?.(null), [])
  const stream = useIssueProjectChat(
    chat,
    group.id,
    item?.id ?? '',
    focusRequestKey ?? 0,
    focusedCommentId ?? undefined,
    historyPage,
    'chat_group'
  )
  const scroll = useRef<HTMLDivElement>(null)
  const contentRead = useThreadContentRead({
    api,
    accountScope,
    groupId: group.id,
    actorId: participation?.current_user_id ?? stream.currentUserId,
    item,
    active,
    loaded: Boolean(chat) && !stream.loading && !stream.error,
    viewport: scroll,
    onRead: onChanged,
  })
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const follow = useRef(true)
  const focused = useFocusedComment(
    scroll,
    stream.messages,
    focusedCommentId,
    focusRequestKey,
    !stream.loading && !stream.error
  )
  useEffect(() => {
    if (focusedCommentId) {
      follow.current = false
    }
  }, [focusedCommentId, focusRequestKey])
  const latest = () => {
    setHistoryState({ owner: null })
    onClearFocus()
    follow.current = true
  }
  const pageHistory = (direction: 'older' | 'newer') => {
    if (!stream.history || stream.loading) return
    setHistoryState({
      owner: null,
      page:
        direction === 'older'
          ? { beforeSequence: stream.history.firstSequence }
          : { afterSequence: stream.history.lastSequence },
    })
    onClearFocus()
    follow.current = false
  }
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const currentThreadId = item?.id
  useEffect(() => {
    if (!currentThreadId) return
    let active = true
    void groups
      .participation(currentThreadId)
      .then(value => {
        if (active) setParticipationState({ threadId: currentThreadId, value })
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [groups, currentThreadId, item])
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [stream.messages, stream.loading, item?.version])
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const changeParticipation = async (joined: boolean, notifications?: 'all' | 'muted') => {
    if (!item) return
    const next = await groups.setParticipation(item.id, {
      joined,
      ...(notifications ? { notifications } : {}),
    })
    setParticipationState({ threadId: item.id, value: next })
    onChanged()
  }
  useEffect(() => {
    if (!onThreadActionContext) return
    onThreadActionContext(
      item && participation && accountScope && requestLeave
        ? {
            group,
            project,
            item,
            api,
            participation,
            accountScope,
            sourceStore: project.project_store === 'local' ? 'local' : 'cloud',
            requestLeave: requestWorkAction,
          }
        : null
    )
  }, [
    onThreadActionContext,
    item,
    participation,
    accountScope,
    requestLeave,
    requestWorkAction,
    group,
    project,
    api,
  ])
  const complete = item?.status === 'completed'
  const canEdit = group.status === 'active' && group.role !== 'Viewer'
  const canSend = canEdit && Boolean(chat) && (!item || participation?.can_comment === true)
  const self = participation?.participants.find(
    person => person.user_id === participation.current_user_id
  )
  const executionContext: ThreadActionContext | null =
    item && participation && accountScope
      ? {
          group,
          project,
          item,
          api,
          participation,
          accountScope,
          sourceStore: project.project_store === 'local' ? 'local' : 'cloud',
          requestLeave: requestWorkAction,
        }
      : null
  const candidates = useThreadAgentCandidates({
    api: catalog.agents,
    groups,
    groupId: group.id,
    threadId: item?.id ?? null,
    accountScope,
    enabled: canSend && item?.permissions?.execute === true,
    ownerRevision: group,
    threadRevision: item?.version,
  })
  const commentExecution = useThreadCommentExecution({
    context: executionContext,
    groups,
    chat,
    active: active && canSend && item?.permissions?.execute === true,
    unavailable: t('executionContextUnavailable'),
    onMessages: stream.merge,
  })
  return (
    <section
      className="flex h-full min-h-0 flex-col"
      data-testid={item ? 'thread-room' : 'group-room'}
      data-focus-request={focusRequestKey ?? undefined}
    >
      <div className="contents" inert={editing} aria-hidden={editing || undefined}>
        {item && (
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-6 py-4">
            {onBackToBoard ? (
              <button
                type="button"
                data-testid="thread-back-to-board"
                onClick={onBackToBoard}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-sm text-text-muted hover:bg-hover"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('backToBoard')}
              </button>
            ) : (
              <button
                type="button"
                data-testid="thread-back-to-group"
                aria-label={group.name}
                onClick={onBack}
                className="rounded p-1 text-text-muted hover:bg-hover"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2 text-xs text-text-muted">
                <span>{group.name}</span>
                <span>›</span>
                <span>{t('threadNumber', { number: item.sequence_number })}</span>
                <span>{translate(`todo.status_${item.status}`, item.status)}</span>
              </div>
              <h1
                data-testid="thread-title"
                className="text-heading-md whitespace-normal break-words text-text-primary"
              >
                {item.title}
              </h1>
              {item.badges?.length ? (
                <IssueChangeRequestBadges
                  badges={item.badges}
                  api={changeRequestApi}
                  compact
                  testId="issue-badges"
                />
              ) : null}
              <p className="mt-1 text-xs text-text-muted">
                {participation
                  ? t('participants', { count: participation.participants.length })
                  : !error && t('loading')}
              </p>
            </div>
            <button
              type="button"
              data-testid="thread-settings"
              aria-label={t('threadSettings')}
              className="rounded p-1 text-text-muted hover:bg-hover"
              onClick={() => setEditing(true)}
            >
              <Info className="h-4 w-4" />
            </button>
            <ActionMenu
              ariaLabel={t('more')}
              testId="thread-more"
              triggerButtonRef={menuTrigger}
              items={[
                {
                  label: t('threadSettings'),
                  testId: 'thread-menu-settings',
                  onSelect: () => setEditing(true),
                },
                ...(canEdit
                  ? [
                      {
                        label: t(complete ? 'reopen' : 'complete'),
                        testId: 'thread-menu-lifecycle',
                        disabled: busy,
                        onSelect: () =>
                          run(async () => {
                            await api.issues.update(item.id, {
                              version: item.version,
                              status: complete ? 'pending' : 'completed',
                            })
                            onChanged()
                          }),
                      },
                      ...(onArchiveThread
                        ? [
                            {
                              label: translate('todo.archive_issue'),
                              testId: 'thread-menu-archive',
                              disabled: busy,
                              onSelect: () => {
                                menuTrigger.current?.focus()
                                onArchiveThread(item)
                              },
                            },
                          ]
                        : []),
                    ]
                  : []),
                ...(participation?.joined && group.status === 'active'
                  ? [
                      {
                        label: t(self?.notifications === 'muted' ? 'unmute' : 'mute'),
                        testId: 'thread-menu-notifications',
                        disabled: busy,
                        onSelect: () =>
                          run(() =>
                            changeParticipation(
                              true,
                              self?.notifications === 'muted' ? 'all' : 'muted'
                            )
                          ),
                      },
                      {
                        label: t('leave'),
                        testId: 'thread-menu-leave',
                        disabled: busy,
                        onSelect: () => run(() => changeParticipation(false)),
                      },
                    ]
                  : []),
              ]}
            />
          </header>
        )}
        {(error || stream.error) && (
          <div role="alert" className="shrink-0 px-6 py-2 text-sm text-destructive">
            {error || (focusedCommentId ? t('messageUnavailable') : stream.error)}
          </div>
        )}
        {contentRead.failed && (
          <div
            role="alert"
            className="shrink-0 px-6 py-2 text-sm text-destructive"
            data-testid="thread-read-error"
          >
            {t('threadReadFailed')}
            <Button variant="ghost" data-testid="thread-read-retry" onClick={contentRead.retry}>
              {t('retry')}
            </Button>
          </div>
        )}
        {stream.historyView && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2 text-xs text-text-muted"
            data-testid="group-history-window"
          >
            <span className="mr-auto" role="status">
              {t('historyWindow')}
            </span>
            <Button
              variant="ghost"
              size="sm"
              data-testid="group-history-older"
              disabled={stream.loading || !stream.history?.hasOlder}
              onClick={() => pageHistory('older')}
            >
              {t('historyOlder')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="group-history-newer"
              disabled={stream.loading || !stream.history?.hasNewer}
              onClick={() => pageHistory('newer')}
            >
              {t('historyNewer')}
            </Button>
            <Button variant="ghost" size="sm" data-testid="group-history-latest" onClick={latest}>
              {t('latestMessages')}
            </Button>
          </div>
        )}
        <div
          ref={scroll}
          onScroll={() => {
            const el = scroll.current
            if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
          }}
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
          data-testid="group-message-list"
        >
          <div className="mx-auto max-w-3xl space-y-5">
            {!stream.loading &&
              !stream.error &&
              focusedCommentId &&
              !stream.messages.some(message => message.messageId === focusedCommentId) && (
                <p role="status" className="text-sm text-text-muted">
                  {t('messageUnavailable')}
                </p>
              )}
            {stream.loading ? (
              <p role="status" className="text-sm text-text-muted">
                {t('loading')}
              </p>
            ) : stream.messages.length === 0 ? (
              <p className="py-16 text-center text-sm text-text-muted">
                {t(item ? 'emptyThreadChat' : 'emptyChat')}
              </p>
            ) : null}
            <ThreadExecutionActivity
              context={executionContext}
              groups={groups}
              chat={chat}
              messages={stream.messages}
              members={members}
              locale={locale}
              focused={focused}
              active={active}
              onReply={
                canSend
                  ? message => setReplyTarget(createGroupReplyTarget(conversationScope, message))
                  : undefined
              }
              onConfigure={() => setEditing(true)}
              onChanged={onChanged}
            >
              {({ renderMessage }) =>
                stream.messages.map(message => {
                  const execution = renderMessage(message)
                  if (execution) return execution
                  const parentMessage = stream.messages.find(
                    parent => parent.messageId === message.replyToMessageId
                  )
                  const threadId = message.metadata.thread_id
                  const lifecycleActor =
                    project.project_store === 'local' && message.sender.id === '0'
                      ? t('you')
                      : message.sender.name
                  const lifecycle = threadLifecycleLabel(message.metadata, locale)
                  if (!item && typeof threadId === 'string' && message.sender.type === 'system')
                    return (
                      <button
                        key={message.messageId}
                        type="button"
                        data-testid={`group-thread-event-${message.messageId}`}
                        data-message-id={message.messageId}
                        data-focused={focused === message.messageId || undefined}
                        data-flash={focused === message.messageId || undefined}
                        onClick={() => onOpenThread(threadId)}
                        className="mx-auto flex w-full max-w-xl items-start gap-3 rounded-lg border border-border p-3 text-left hover:bg-hover"
                      >
                        <Hash className="mt-1 h-4 w-4 shrink-0 text-text-muted" />
                        <span className="min-w-0">
                          <span className="block text-xs text-text-muted">
                            {t(
                              lifecycle.key,
                              lifecycle.status ? { status: lifecycle.status } : undefined
                            )}
                          </span>
                          <span className="mt-1 block truncate text-sm font-medium text-text-primary">
                            {message.content}
                          </span>
                          <span className="mt-1 block text-xs text-text-muted">
                            {lifecycleActor ? `${lifecycleActor} · ` : ''}
                            <time dateTime={message.createdAt}>
                              {formatIssueTimestamp(message.createdAt)}
                            </time>
                          </span>
                        </span>
                      </button>
                    )
                  return (
                    <GroupChatMessage
                      key={message.messageId}
                      message={message}
                      currentUserId={stream.currentUserId}
                      focused={focused === message.messageId}
                      scopeKey={conversationScope}
                      replyTo={
                        parentMessage
                          ? createGroupReplyTarget(conversationScope, parentMessage)
                          : null
                      }
                      onReply={
                        canSend
                          ? target =>
                              setReplyTarget(createGroupReplyTarget(conversationScope, target))
                          : undefined
                      }
                    />
                  )
                })
              }
            </ThreadExecutionActivity>
          </div>
        </div>
        <footer className="shrink-0 px-6 pb-5 pt-2">
          <div className="mx-auto max-w-3xl">
            {canSend && candidates.pending && (
              <p role="status" className="mb-2 text-xs text-text-muted">
                {t('loadingAgents')}
              </p>
            )}
            {canSend && candidates.failed && (
              <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-text-muted">
                <span>{t('agentLoadFailed')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="group-message-agents-retry"
                  onClick={candidates.retry}
                >
                  {t('retry')}
                </Button>
              </div>
            )}
            {canSend && commentExecution.error && (
              <div role="alert" className="mb-2 flex items-center gap-2 text-sm text-destructive">
                <span>{commentExecution.error}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="thread-comment-execution-retry"
                  disabled={commentExecution.busy}
                  onClick={() => void commentExecution.retry()}
                >
                  {t('retry')}
                </Button>
              </div>
            )}
            {item && !participation ? (
              !error && (
                <p
                  role="status"
                  className="py-2 text-center text-sm text-text-muted"
                  data-testid="thread-participation-loading"
                >
                  {t('loading')}
                </p>
              )
            ) : item && participation && !participation.joined && group.status === 'active' ? (
              <div
                className="flex items-center gap-4 rounded-xl border border-border p-4"
                data-testid="thread-observer"
              >
                <p className="flex-1 text-sm text-text-muted">
                  {t(group.role === 'Viewer' ? 'viewerObserverHint' : 'observerHint')}
                </p>
                <Button
                  data-testid="thread-join"
                  disabled={busy}
                  onClick={() => void run(() => changeParticipation(true))}
                >
                  {t(group.role === 'Viewer' ? 'follow' : 'join')}
                </Button>
              </div>
            ) : canSend ? (
              <GroupMessageComposer
                key={conversationScope}
                scopeKey={conversationScope}
                replyTarget={replyTarget}
                onCancelReply={target =>
                  setReplyTarget(current => (current === target ? null : current))
                }
                threadId={item?.id ?? null}
                members={members}
                agents={candidates.agents}
                api={api}
                currentUserId={stream.currentUserId}
                translate={translate}
                onSend={async (text, replyToMessageId, mentions) => {
                  const message = await stream.send(text, replyToMessageId, mentions)
                  if (
                    item &&
                    item.permissions?.execute === true &&
                    threadCommentRequestsExecution(message, stream.messages)
                  ) {
                    await commentExecution.execute(message)
                  }
                  if (stream.historyView) latest()
                  else follow.current = true
                }}
              />
            ) : (
              <p className="py-2 text-center text-sm text-text-muted" data-testid="group-readonly">
                {t(complete ? 'completed' : 'readOnly')}
              </p>
            )}
          </div>
        </footer>
      </div>
      {editing && item && (
        <div className="absolute inset-0 z-20 bg-background">
          <ThreadSettings
            registerLeaveGuard={registerLeaveGuard}
            renderHierarchy={context => (
              <>
                <ThreadHierarchySection
                  context={context}
                  group={group}
                  items={items}
                  locale={locale}
                  onOpenThread={onOpenRelatedThread}
                  onCreateChild={
                    onCreateChild
                      ? (parent, classificationProject) => {
                          setEditing(false)
                          onCreateChild(parent, classificationProject)
                        }
                      : undefined
                  }
                />
                {accountScope &&
                  renderThreadActions?.({
                    group,
                    project,
                    item: context.item,
                    api,
                    participation,
                    accountScope,
                    sourceStore: project.project_store === 'local' ? 'local' : 'cloud',
                    requestLeave: action => requestWorkAction(action, context.requestLeave),
                  })}
              </>
            )}
            item={item}
            project={project}
            group={group}
            items={items}
            members={members}
            locale={locale}
            api={api}
            catalog={catalog}
            groups={groups}
            participation={participation}
            onParticipation={value => setParticipationState({ threadId: item.id, value })}
            onClose={() => setEditing(false)}
            onChanged={onChanged}
          />
        </div>
      )}
    </section>
  )
}
