import { useCallback, useState } from 'react'
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
import { useCloudIssueApis } from './useCloudIssueApis'

export type TaskIssueShareDraft = {
  title: string
  requestId: string
  source: SharedIssueSource
  excerpts: Pick<WorkbenchMessage, 'id' | 'role' | 'content'>[]
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
}: {
  title: string
  messages: WorkbenchMessage[]
  address: { deviceId: string; taskId: string }
}) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const apis = useCloudIssueApis(cloud)
  const [draft, setDraft] = useState<TaskIssueShareDraft | null>(null)
  const [projectIssue, setProjectIssue] = useState<SharedIssueTarget | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
  const personal = apis?.personal
  const loadLinks = useCallback(
    () =>
      personal?.sharedFrom({ device_id: address.deviceId, task_id: address.taskId }) ??
      Promise.resolve([]),
    [personal, address.deviceId, address.taskId]
  )
  const { data: links, refresh: refreshLinks } = usePanelData(loadLinks, Boolean(personal))
  const clearProjectIssue = useCallback(() => setProjectIssue(null), [])
  const close = () => {
    setDraft(null)
  }
  const label = t('taskIssueShare.action')

  return (
    <div className="relative ml-auto flex shrink-0 items-center gap-1">
      {Boolean(links?.length) && (
        <>
          <button
            type="button"
            data-testid="task-linked-issues"
            aria-expanded={linksOpen}
            title={t('taskIssueShare.linkedIssues')}
            aria-label={t('taskIssueShare.linkedIssues')}
            onClick={() => setLinksOpen(open => !open)}
            className="flex h-11 items-center gap-1 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted md:h-7"
          >
            <Link2 className="h-4 w-4" aria-hidden="true" />
            {links?.length}
          </button>
          {linksOpen && (
            <ul className="absolute right-0 top-full z-popover mt-1 grid w-64 gap-1 rounded-lg border border-border bg-popover p-1 shadow-md">
              {links?.map(issue => (
                <li key={issue.id}>
                  <button
                    type="button"
                    data-testid={`task-linked-issue-${issue.id}`}
                    className="min-h-11 w-full truncate rounded px-2 text-left text-sm hover:bg-muted md:min-h-8"
                    title={issue.title}
                    onClick={() => {
                      if (openIssue(issue)) setLinksOpen(false)
                    }}
                  >
                    {issue.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <button
        type="button"
        data-testid="task-share-as-issue"
        aria-label={label}
        title={label}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:h-7"
        onClick={() => {
          setLinksOpen(false)
          setProjectIssue(null)
          const sourceTitle = Array.from(title.trim()).slice(0, 255).join('')
          setDraft({
            requestId: crypto.randomUUID(),
            source: { device_id: address.deviceId, task_id: address.taskId, title: sourceTitle },
            title: sourceTitle,
            excerpts: messages.flatMap(message => {
              if (message.status !== 'done' || message.contentTruncated) return []
              const { id, role } = message
              if (role === 'system') return []
              const content =
                role === 'assistant'
                  ? getAssistantRenderProjection(message).content.trim()
                  : getUserMessageTextProjection(message.content).content.trim()
              return content ? [{ id, role, content }] : []
            }),
          })
        }}
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">{label}</span>
      </button>
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
                  : 'taskIssueShare.shared'
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
