import { groupWorkContainer } from '@/api/groupWorkContainer'
import { useEffect, useMemo, useState } from 'react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { WorkItemContextPanel } from '@/features/todo/WorkItemContextPanel'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { openWeworkScheme } from './schemeEvents'
import { weworkIssueScheme, weworkTaskScheme, weworkThreadScheme } from './scheme'

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
  const groups = services.chatGroupApis?.[store === 'local' ? 'local' : 'cloud']
  const scope = useMemo(
    () => ({ api, groups, projectId, issueId, store, user: state.user?.id, url }),
    [api, groups, projectId, issueId, store, state.user?.id, url]
  )
  const [result, setResult] = useState<{
    scope: object
    project?: CloudProject
    item?: CloudLoopItem
    error?: string
  } | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!api || !active) return
    let current = true
    void api
      .getLoopItem(issueId)
      .then(async item => {
        if (!current) return
        if (String(item.cloud_project_id) !== projectId)
          throw new Error(t('interactions.entity_unavailable'))
        let project: CloudProject | undefined
        if (item.group_id) {
          if (item.group_id !== projectId || !groups)
            throw new Error(t('interactions.entity_unavailable'))
          const record = await groups.get(item.group_id)
          if (record.group.id !== item.group_id)
            throw new Error(t('interactions.entity_unavailable'))
          project = groupWorkContainer(record.group, store === 'local' ? 'local' : 'cloud')
        } else {
          project = (await api.listCloudProjects()).items.find(
            candidate => String(candidate.id) === projectId
          )
        }
        if (!project) throw new Error(t('interactions.entity_unavailable'))
        if (current) setResult({ scope, project, item })
      })
      .catch(error => {
        if (current)
          setResult({ scope, error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      current = false
    }
  }, [active, api, groups, issueId, projectId, revision, t, scope, store])
  if (!api || (result?.scope === scope && result.error))
    return (
      <div className="space-y-3 p-5">
        <p role="alert" className="text-sm text-error">
          {(result?.scope === scope ? result.error : undefined) ??
            t('interactions.entity_unavailable')}
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
  if (result?.scope !== scope || !result.item || !result.project)
    return (
      <p role="status" className="p-5 text-sm text-text-secondary">
        {t('interactions.loading')}
      </p>
    )
  return (
    <WorkItemContextPanel
      readFirst
      active={active}
      key={url}
      api={api}
      services={services}
      project={result.project}
      item={result.item}
      currentTask={address}
      runtimeWork={state.runtimeWork}
      currentUserId={state.user?.id}
      localProjects={state.projects}
      deviceNamesById={getWorkbenchDeviceNamesById(state.devices)}
      focusedCommentId={commentId}
      focusedCommentRequestKey={url}
      onOpenChildTask={item => {
        openWeworkScheme(
          item.group_id
            ? weworkThreadScheme(item.group_id, item.id, store)
            : weworkIssueScheme(projectId, item.id, store)
        )
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
