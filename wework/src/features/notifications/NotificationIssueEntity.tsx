import { useEffect, useState } from 'react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { WorkItemContextPanel } from '@/features/todo/WorkItemContextPanel'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { openWeworkScheme } from './schemeEvents'
import { weworkIssueScheme, weworkTaskScheme } from './scheme'

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
  const [result, setResult] = useState<{
    key: string
    project?: CloudProject
    item?: CloudLoopItem
    error?: string
  } | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!api || !active) return
    let current = true
    void Promise.all([api.listCloudProjects(), api.getLoopItem(issueId)])
      .then(([projects, item]) => {
        const project = projects.items.find(project => project.id === projectId)
        if (!project || item.cloud_project_id !== project.id)
          throw new Error(t('interactions.entity_unavailable'))
        if (current) setResult({ key: url, project, item })
      })
      .catch(error => {
        if (current)
          setResult({ key: url, error: String(error instanceof Error ? error.message : error) })
      })
    return () => {
      current = false
    }
  }, [active, api, issueId, projectId, revision, t, url])
  if (!api || (result?.key === url && result.error))
    return (
      <div className="space-y-3 p-5">
        <p role="alert" className="text-sm text-error">
          {result?.error ?? t('interactions.entity_unavailable')}
        </p>
        {api && (
          <button
            type="button"
            data-testid="notification-entity-retry"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => {
              setResult(null)
              setRevision(value => value + 1)
            }}
          >
            {t('workbench.retry')}
          </button>
        )}
      </div>
    )
  if (result?.key !== url || !result.item || !result.project)
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
      currentUserId={store === 'local' ? 0 : state.user?.id}
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
