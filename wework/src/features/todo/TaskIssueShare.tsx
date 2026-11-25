import { createPortal } from 'react-dom'
import { Button } from '@wegent/collaboration/markdown/Button'
import { useCallback, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { usePanelData, type TaskIssueShareDraft } from '@wegent/collaboration/platform'
import type { SharedIssueTarget } from '@/api/personalIssues'
import { Link2, Share2 } from 'lucide-react'
import type {
  WorkbenchMessage,
  RuntimeConversationTurn,
} from '@wegent/chat-core/runtime-conversation'
import {
  type ConversationShareSelectionContext,
  getAssistantContentPresentation,
  getUserMessageTextProjection,
} from '@wegent/collaboration/conversation'
import { TransientNotice } from '@/components/common/TransientNotice'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import { openWeworkScheme } from '@/features/notifications/schemeEvents'
import { weworkIssueScheme, weworkPersonalIssueScheme } from '@/features/notifications/scheme'
import { IndependentIssueDialog } from './IndependentIssueDialog'
import { useAttachmentDownload } from '@/components/chat/AttachmentDownloadContext'
import type { ReadWorkspaceFileChunk } from '@/lib/workspace-file-bytes'
import { taskIssueConversationFiles } from './taskIssueConversationFiles'
import { useCloudIssueApis } from './useCloudIssueApis'
import type { RuntimeTranscriptResponse } from '@/types/api'
import { projectRuntimePaneTranscript } from '@wegent/chat-core/runtime-transcript-page'

export type { TaskIssueShareDraft } from '@wegent/collaboration/platform'

function shareExcerpts(
  messages: WorkbenchMessage[],
  turns: RuntimeConversationTurn[] = []
): TaskIssueShareDraft['excerpts'] {
  const positions = new Map(
    turns.flatMap(turn =>
      turn.items.flatMap(item =>
        turn.position !== undefined && item.position !== undefined
          ? [[`${turn.id}:${item.id}`, [turn.position, item.position] as [number, number]] as const]
          : []
      )
    )
  )
  return messages.flatMap(message => {
    if (message.status !== 'done' || message.contentTruncated || message.role === 'system')
      return []
    const content =
      message.role === 'assistant'
        ? getAssistantContentPresentation(message).content.trim()
        : getUserMessageTextProjection(message.content).content.trim()
    const itemId = message.runtimeItemId ?? message.runtimeDisplayItems?.[0]?.id
    const order = positions.get(`${message.turnId}:${itemId}`)
    return content ? [{ id: message.id, role: message.role, content, order }] : []
  })
}

type ShareHistoryPage = {
  excerpts: TaskIssueShareDraft['excerpts']
  beforeCursor: string | null
}

type ShareHistoryRequest = {
  beforeCursor?: string
  afterCursor?: string
  limit: number
}
type ReadSharePage = (request: ShareHistoryRequest) => Promise<RuntimeTranscriptResponse>
const SHARE_HISTORY_PAGE_SIZE = 1

function readShareHistory(read: ReadSharePage) {
  async function first() {
    const page = await read({ afterCursor: 'start', limit: 1 })
    const transcript = projectRuntimePaneTranscript(page)
    const excerpt = shareExcerpts(transcript.messages, transcript.turns)[0]
    if (page.historyUnavailable || (!excerpt && page.hasMoreAfter))
      throw new Error('The beginning of the conversation is unavailable')
    return excerpt
  }

  async function earlier(cursor?: string): Promise<ShareHistoryPage> {
    const page = await read({ beforeCursor: cursor, limit: SHARE_HISTORY_PAGE_SIZE })
    if (
      page.historyUnavailable ||
      (page.hasMoreBefore && (!page.beforeCursor || page.beforeCursor === cursor))
    )
      throw new Error('Conversation history is unavailable')
    const transcript = projectRuntimePaneTranscript(page)
    return {
      excerpts: shareExcerpts(transcript.messages, transcript.turns),
      beforeCursor: page.hasMoreBefore ? (page.beforeCursor ?? null) : null,
    }
  }

  return { first, earlier }
}

function openIssue(issue: SharedIssueTarget) {
  return openWeworkScheme(
    issue.project_id
      ? weworkIssueScheme(issue.project_id, issue.id)
      : weworkPersonalIssueScheme(issue.id)
  )
}

export interface TaskIssueShareHandle {
  openSelection(text: string, context: ConversationShareSelectionContext): void
}

export function TaskIssueShare({
  shareRef,
  toolbarContainer,
  title,
  readTranscript,
  address,
  readWorkspaceFileChunk,
  readHistoryPage,
}: {
  toolbarContainer: HTMLElement | null
  shareRef?: Ref<TaskIssueShareHandle>
  title: string
  readTranscript: () => { messages: WorkbenchMessage[]; turns: RuntimeConversationTurn[] }
  address: { deviceId: string; taskId: string; workspacePath?: string | null }
  readWorkspaceFileChunk?: ReadWorkspaceFileChunk
  readHistoryPage?(
    request: ShareHistoryRequest,
    signal: AbortSignal
  ): Promise<RuntimeTranscriptResponse>
}) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const fetchAttachment = useAttachmentDownload()
  const apis = useCloudIssueApis(cloud)
  const [draft, setDraft] = useState<TaskIssueShareDraft | null>(null)
  const historyRequest = useRef<AbortController | null>(null)
  const [projectIssue, setProjectIssue] = useState<SharedIssueTarget | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  const linksTrigger = useRef<HTMLButtonElement>(null)
  const personal = apis?.personal
  const loadLinks = useCallback(
    () =>
      personal?.sharedFrom({ device_id: address.deviceId, task_id: address.taskId }) ??
      Promise.resolve([]),
    [personal, address.deviceId, address.taskId]
  )
  const {
    data: links,
    error: linksError,
    loading: linksLoading,
    refresh: refreshLinks,
  } = usePanelData(loadLinks, Boolean(personal))
  const clearProjectIssue = useCallback(() => setProjectIssue(null), [])
  const close = () => {
    historyRequest.current?.abort()
    historyRequest.current = null
    setDraft(null)
  }
  const openShare = (selection?: string, context?: ConversationShareSelectionContext) => {
    const { messages, turns } = readTranscript()
    setLinksOpen(false)
    setProjectIssue(null)
    const sourceTitle = Array.from(title.trim()).slice(0, 255).join('')
    const sourceMessages = context?.messages ?? messages
    const sourceTurns = context?.turns ?? turns
    const excerpts = shareExcerpts(messages, turns)
    const sourceExcerpts =
      sourceMessages === messages && sourceTurns === turns
        ? excerpts
        : shareExcerpts(sourceMessages, sourceTurns)
    const sourceMessage =
      context && sourceMessages.find(message => message.id === context.messageId)
    const selectedExcerpt =
      selection && context && sourceMessage
        ? {
            excerpt: {
              id: sourceMessage.id,
              role: sourceMessage.role,
              content: context.content,
              order: sourceExcerpts.find(excerpt => excerpt.id === sourceMessage.id)?.order,
            },
            start: context.start,
            end: context.start + selection.length,
            followingMessageIds: sourceMessages
              .slice(sourceMessages.indexOf(sourceMessage) + 1)
              .map(message => message.id),
          }
        : undefined
    historyRequest.current?.abort()
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    historyRequest.current = controller
    const history = readHistoryPage
      ? readShareHistory(request => readHistoryPage(request, controller.signal))
      : undefined
    const last = excerpts.slice(-1)
    setDraft({
      requestId,
      source: { device_id: address.deviceId, task_id: address.taskId, title: sourceTitle },
      title: sourceTitle,
      conversationFiles: taskIssueConversationFiles(
        messages,
        address,
        readWorkspaceFileChunk,
        fetchAttachment
      ),
      excerpts: history ? last : excerpts,
      history,
      selectedExcerpt,
    })
    void history?.first().then(
      first =>
        setDraft(current =>
          current?.requestId === requestId && first && first.id !== last[0]?.id
            ? { ...current, excerpts: [first, ...last] }
            : current
        ),
      () =>
        setDraft(current =>
          current?.requestId === requestId ? { ...current, historyUnavailable: true } : current
        )
    )
  }
  useImperativeHandle(shareRef, () => ({ openSelection: openShare }))
  const label = t('taskIssueShare.action')

  return (
    <>
      {toolbarContainer &&
        createPortal(
          <div className="relative ml-auto flex shrink-0 items-center gap-1">
            {(Boolean(links?.length) || linksError !== undefined || linksOpen) && (
              <>
                <Button
                  variant="unstyled"
                  showTooltip={false}
                  type="button"
                  ref={linksTrigger}
                  data-testid="task-linked-issues"
                  aria-expanded={linksOpen}
                  title={t('taskIssueShare.linkedIssues')}
                  aria-label={t('taskIssueShare.linkedIssues')}
                  onClick={() => setLinksOpen(open => !open)}
                  className="flex h-11 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted md:h-7"
                >
                  <Link2 className="h-4 w-4" aria-hidden="true" />
                  {links?.length || null}
                </Button>
                {linksOpen && (
                  <ul className="absolute right-0 top-full z-popover mt-1 grid w-64 gap-1 rounded-lg border border-border bg-popover p-1 shadow-md">
                    {(linksError !== undefined || linksLoading) && (
                      <li className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                        <span role="status">
                          {t(
                            linksLoading
                              ? 'independentIssues.loading'
                              : 'taskIssueShare.linksUnavailable'
                          )}
                        </span>
                        <Button
                          variant="unstyled"
                          showTooltip={false}
                          type="button"
                          data-testid="task-linked-issues-retry"
                          className="min-h-8 rounded px-2 hover:bg-muted"
                          aria-disabled={linksLoading}
                          onClick={event => {
                            if (linksLoading) return
                            if (document.activeElement === event.currentTarget)
                              linksTrigger.current?.focus()
                            void refreshLinks()
                          }}
                        >
                          {t('independentIssues.retry')}
                        </Button>
                      </li>
                    )}
                    {!linksLoading && linksError === undefined && !links?.length && (
                      <li role="status" className="px-2 py-1 text-sm text-text-secondary">
                        {t('taskIssueShare.noLinkedIssues')}
                      </li>
                    )}
                    {links?.map(issue => (
                      <li key={issue.id}>
                        <Button
                          variant="unstyled"
                          showTooltip={false}
                          type="button"
                          data-testid={`task-linked-issue-${issue.id}`}
                          className="min-h-11 w-full truncate rounded px-2 text-left text-sm hover:bg-muted md:min-h-8"
                          title={issue.title}
                          onClick={() => {
                            if (openIssue(issue)) setLinksOpen(false)
                          }}
                        >
                          {issue.title}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <Button
              variant="unstyled"
              showTooltip={false}
              type="button"
              data-testid="task-share-as-issue"
              aria-label={label}
              title={label}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:h-7"
              onClick={() => {
                openShare()
              }}
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
              <span
                data-testid="task-share-as-issue-label"
                className="hidden [@container_(min-width:480px)]:inline"
              >
                {label}
              </span>
            </Button>
          </div>,
          toolbarContainer
        )}
      {draft && !apis && (
        <CloudConnectionDialog
          open
          intent="share-issue"
          onlineCloudDeviceCount={0}
          onClose={close}
          onConnected={() => undefined}
        />
      )}
      {draft && apis && cloud.user && (
        <IndependentIssueDialog
          key={`${cloud.apiBaseUrl ?? ''}:${cloud.user.id}`}
          api={apis.personal}
          userId={Number(cloud.user.id)}
          issueId={null}
          shareDraft={draft}
          onOpenChildTask={issue => {
            if (openWeworkScheme(weworkPersonalIssueScheme(issue.id))) close()
          }}
          onSaved={() => void refreshLinks()}
          onOpenProjectIssue={(projectId, issueId, restricted) => {
            setProjectIssue({
              project_id: projectId,
              id: issueId,
              restricted: Boolean(restricted),
              title: draft.title,
            })
            void refreshLinks()
          }}
          onClose={close}
        />
      )}
      <TransientNotice
        message={
          projectIssue
            ? t(
                projectIssue.restricted
                  ? 'taskIssueShare.createdRestricted'
                  : 'taskIssueShare.created'
              )
            : null
        }
        onClear={clearProjectIssue}
        action={
          projectIssue
            ? {
                label: t('taskIssueShare.viewSharedIssue'),
                testId: 'task-share-view-project-issue',
                pending: false,
                onClick: () => {
                  if (openIssue(projectIssue)) clearProjectIssue()
                },
              }
            : undefined
        }
      />
    </>
  )
}
