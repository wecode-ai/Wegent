import { WorkItemContextPanel } from '@/features/todo/WorkItemContextPanel'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { memo, useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'
import { openWeworkScheme } from './schemeEvents'

class UnavailableNotificationEntity extends Error {}

const IssuePreview = memo(WorkItemContextPanel)

function openRuntimeTask(task: RuntimeTaskAddress) {
  openWeworkScheme(weworkTaskScheme(task))
}

/** Load the destination's real records into the existing Issue detail surface. */
export function NotificationIssueEntity({
  projectId,
  issueId,
  store,
  commentId,
  url,
  address,
  active,
  headerActions,
}: {
  projectId: string
  issueId: string
  store: 'local' | 'backend'
  commentId?: string
  url: string
  address?: RuntimeTaskAddress
  active: boolean
  headerActions?: ReactNode
}) {
  const { state, services } = useWorkbench()
  const { t } = useTranslation('common')
  const api = services.projectSpaceApis?.[store === 'local' ? 'local' : 'cloud']
  const userId = state.user?.id
  const deviceNamesById = useMemo(() => getWorkbenchDeviceNamesById(state.devices), [state.devices])
  const openChildTask = useCallback(
    (item: { id: string }) => openWeworkScheme(weworkIssueScheme(projectId, item.id, store)),
    [projectId, store]
  )
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
        {headerActions}
        <p role="alert" className="text-sm text-error">
          {error ?? t('interactions.entity_unavailable')}
        </p>
        {api && (
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid="notification-entity-retry"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => void resource?.reload()}
          >
            {t('workbench.retry')}
          </ControlButton>
        )}
      </div>
    )
  if (!result)
    return (
      <>
        {headerActions}
        <p role="status" className="p-5 text-sm text-text-secondary">
          {t('interactions.loading')}
        </p>
      </>
    )
  return (
    <IssuePreview
      readFirst
      headerActions={headerActions}
      key={url}
      api={api}
      services={services}
      project={result.project}
      item={result.item}
      currentTask={address}
      currentUserId={userId}
      localProjects={state.projects}
      deviceNamesById={deviceNamesById}
      focusedCommentId={commentId}
      focusedCommentRequestKey={url}
      onOpenChildTask={openChildTask}
      onOpenRuntimeTask={openRuntimeTask}
      onOpenTask={openRuntimeTask}
    />
  )
}
