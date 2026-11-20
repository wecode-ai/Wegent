import { Button } from '@wegent/collaboration/markdown/Button'
import { useCallback, useRef, useState } from 'react'
import { usePanelData } from '@wegent/collaboration/platform'
import type { SharedIssueSource, SharedIssueTarget } from '@/api/personalIssues'
import { Link2, Share2 } from 'lucide-react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import {
  getAssistantRenderProjection,
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
import {
  taskIssueConversationFiles,
  type TaskIssueConversationFile,
} from './taskIssueConversationFiles'
import { useCloudIssueApis } from './useCloudIssueApis'
import type { RuntimeTranscriptResponse } from '@/types/api'
import { projectRuntimePaneTranscript } from '@wegent/chat-core/runtime-transcript-page'

export type TaskIssueShareDraft = {
  title: string
  requestId: string
  source: SharedIssueSource
  conversationFiles: TaskIssueConversationFile[]
  excerpts: Pick<WorkbenchMessage, 'id' | 'role' | 'content'>[]
  historyUnavailable?: boolean
  history?: {
    first: Promise<TaskIssueShareDraft['excerpts']>
    all(): Promise<TaskIssueShareDraft['excerpts']>
  }
}

function shareExcerpts(messages: WorkbenchMessage[]): TaskIssueShareDraft['excerpts'] {
  return messages.flatMap(message => {
    if (message.status !== 'done' || message.contentTruncated || message.role === 'system')
      return []
    const content =
      message.role === 'assistant'
        ? getAssistantRenderProjection(message).content.trim()
        : getUserMessageTextProjection(message.content).content.trim()
    return content ? [{ id: message.id, role: message.role, content }] : []
  })
}

type ReadSharePage = (cursor: string, limit: number) => Promise<RuntimeTranscriptResponse>

function readShareHistory(read: ReadSharePage, tail: TaskIssueShareDraft['excerpts']) {
  async function readPage(cursor: string, limit: number) {
    const page = await read(cursor, limit)
    if (page.historyUnavailable || (page.hasMoreAfter && !page.afterCursor))
      throw new Error('Conversation history is unavailable')
    return page
  }
  const start = readPage('start', 16)
  const combine = (head: TaskIssueShareDraft['excerpts']) => [
    ...new Map([...head, ...tail].map(excerpt => [excerpt.id, excerpt])).values(),
  ]
  const first = start.then(page =>
    combine(shareExcerpts(projectRuntimePaneTranscript(page).messages))
  )
  let all: Promise<TaskIssueShareDraft['excerpts']> | undefined
  return {
    first,
    all: () =>
      (all ??= (async () => {
        let page = await start
        const excerpts = shareExcerpts(projectRuntimePaneTranscript(page).messages)
        while (page.hasMoreAfter && page.afterCursor) {
          const cursor = page.afterCursor
          page = await readPage(cursor, 60)
          if (page.afterCursor === cursor) throw new Error('Transcript cursor did not advance')
          excerpts.push(...shareExcerpts(projectRuntimePaneTranscript(page).messages))
        }
        return combine(excerpts)
      })().catch(error => {
        all = undefined
        throw error
      })),
  }
}

function openIssue(issue: SharedIssueTarget) {
  return openWeworkScheme(
    issue.project_id
      ? weworkIssueScheme(issue.project_id, issue.id)
      : weworkPersonalIssueScheme(issue.id)
  )
}

export function TaskIssueShare({
  title,
  messages,
  address,
  readWorkspaceFileChunk,
  readHistoryPage,
}: {
  title: string
  messages: WorkbenchMessage[]
  address: { deviceId: string; taskId: string; workspacePath?: string | null }
  readWorkspaceFileChunk?: ReadWorkspaceFileChunk
  readHistoryPage?(
    cursor: string,
    limit: number,
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
  const label = t('taskIssueShare.action')

  return (
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
                      linksLoading ? 'independentIssues.loading' : 'taskIssueShare.linksUnavailable'
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
          setLinksOpen(false)
          setProjectIssue(null)
          const sourceTitle = Array.from(title.trim()).slice(0, 255).join('')
          const excerpts = shareExcerpts(messages)
          historyRequest.current?.abort()
          const requestId = crypto.randomUUID()
          const controller = new AbortController()
          historyRequest.current = controller
          const history = readHistoryPage
            ? readShareHistory(
                (cursor, limit) => readHistoryPage(cursor, limit, controller.signal),
                excerpts
              )
            : undefined
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
            excerpts: history ? [] : excerpts,
            history,
          })
          void history?.first.then(
            first =>
              setDraft(current =>
                current?.requestId === requestId ? { ...current, excerpts: first } : current
              ),
            () =>
              setDraft(current =>
                current?.requestId === requestId
                  ? { ...current, historyUnavailable: true }
                  : current
              )
          )
        }}
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">{label}</span>
      </Button>
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
    </div>
  )
}
