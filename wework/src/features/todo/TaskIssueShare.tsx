import { useCallback, useState } from 'react'
import { Share2 } from 'lucide-react'
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
import { weworkIssueScheme } from '@/features/notifications/scheme'
import { IndependentIssueDialog } from './IndependentIssueDialog'
import { useCloudIssueApis } from './useCloudIssueApis'

export type TaskIssueShareDraft = {
  title: string
  requestId: string
  excerpts: Pick<WorkbenchMessage, 'id' | 'role' | 'content'>[]
}

export function TaskIssueShare({
  title,
  messages,
}: {
  title: string
  messages: WorkbenchMessage[]
}) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const apis = useCloudIssueApis(cloud)
  const [draft, setDraft] = useState<TaskIssueShareDraft | null>(null)
  const [projectIssue, setProjectIssue] = useState<{
    projectId: string
    issueId: string
    restricted?: boolean
  } | null>(null)

  const clearProjectIssue = useCallback(() => setProjectIssue(null), [])
  const close = () => {
    setDraft(null)
  }
  const label = t('taskIssueShare.action')

  return (
    <>
      <button
        type="button"
        data-testid="task-share-as-issue"
        aria-label={label}
        title={label}
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-ring md:h-7"
        onClick={() => {
          setProjectIssue(null)
          setDraft({
            requestId: crypto.randomUUID(),
            title: Array.from(title.trim()).slice(0, 255).join(''),
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
          createSharedProjectIssue={async (projectId, projectStatus, input) => {
            const issue = await apis.projects.createLoopItem(projectId, {
              request_id: draft.requestId,
              title: input.title,
              description: input.description,
              ...(projectStatus && { status: projectStatus }),
            })
            return {
              project_id: projectId,
              issue_id: issue.id,
              restricted: issue.security_level === 'related',
            }
          }}
          onSaved={() => undefined}
          onOpenProjectIssue={(projectId, issueId, restricted) => {
            setProjectIssue({ projectId, issueId, restricted })
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
                  if (
                    openWeworkScheme(
                      weworkIssueScheme(projectIssue.projectId, projectIssue.issueId)
                    )
                  ) {
                    clearProjectIssue()
                  }
                },
              }
            : undefined
        }
      />
    </>
  )
}
