import { useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { WorkItemContextPanel } from '@/features/todo/WorkItemContextPanel'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { openWeworkScheme } from './schemeEvents'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'

class UnavailableNotificationEntity extends Error {}

/** Load the destination's real records into the existing Issue detail surface. */
export function NotificationIssueEntity({
  projectId,
  issueId,
  store,
  commentId,
  url,
  address,
  active,
}: {
  projectId: string
  issueId: string
  store: 'local' | 'backend'
  commentId?: string
  url: string
  address?: RuntimeTaskAddress
  active: boolean
}) {
  const { state, services } = useWorkbench()
  const { t } = useTranslation('common')
  const api = services.projectSpaceApis?.[store === 'local' ? 'local' : 'cloud']
  const userId = state.user?.id
  const resource = useMemo(
    () =>
      api
        ? createAsyncResource(
            JSON.stringify([store, userId, projectId, issueId]),
            async () => {
              const [projects, item] = await Promise.all([
                api.listCloudProjects(),
                api.getLoopItem(issueId),
              ])
              const project = projects.items.find(project => project.id === projectId)
              if (!project || item.cloud_project_id !== project.id)
                throw new UnavailableNotificationEntity()
              return { project, item }
            },
            { refreshOnSubscribe: true }
          )
        : null,
    [api, projectId, issueId, store, userId]
  )
  const snapshot = useSyncExternalStore(
    active && resource ? resource.subscribe : subscribeIdleResource,
    resource?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const result = snapshot.data
  const error =
    snapshot.status === 'error'
      ? snapshot.error instanceof UnavailableNotificationEntity
        ? t('interactions.entity_unavailable')
        : snapshot.error instanceof Error
          ? snapshot.error.message || t('interactions.entity_unavailable')
          : String(snapshot.error)
      : null
  if (!api || snapshot.status === 'error')
    return (
      <div className="space-y-3 p-5">
        <p role="alert" className="text-sm text-error">
          {error ?? t('interactions.entity_unavailable')}
        </p>
        {api && (
          <button
            type="button"
            data-testid="notification-entity-retry"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => void resource?.reload()}
          >
            {t('workbench.retry')}
          </button>
        )}
      </div>
    )
  if (!result)
    return (
      <p role="status" className="p-5 text-sm text-text-secondary">
        {t('interactions.loading')}
      </p>
    )
  return (
    <WorkItemContextPanel
      readFirst
      key={url}
      api={api}
      services={services}
      project={result.project}
      item={result.item}
      currentTask={address}
      currentUserId={userId}
      localProjects={state.projects}
      deviceNamesById={getWorkbenchDeviceNamesById(state.devices)}
      focusedCommentId={commentId}
      focusedCommentRequestKey={url}
      onOpenChildTask={item => {
        openWeworkScheme(weworkIssueScheme(projectId, item.id, store))
      }}
      onOpenRuntimeTask={task => {
        openWeworkScheme(weworkTaskScheme(task))
      }}
      onOpenTask={task => {
        openWeworkScheme(weworkTaskScheme(task))
      }}
    />
  )
}
