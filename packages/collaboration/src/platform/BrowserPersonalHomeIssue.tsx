import { useMemo, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { IssueDetail } from '../IssueDetail'
import { collaborationMessages, type CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { toSharedIssueDetailTaskBinding } from '../issue-detail/createSharedIssueDetailPort'
import type { PersonalHomeIssueDetailContext } from './PersonalIssuesView'
import { Button } from '../markdown/Button'
import { ArrowLeft, ArrowUpRight } from 'lucide-react'

export function BrowserPersonalHomeIssue({
  api,
  locale,
  context,
  translate: t,
}: {
  api: SharedWorkspaceApi
  locale: CollaborationLocale
  context: PersonalHomeIssueDetailContext
  translate(key: string): string
}) {
  const { issue, project, taskRequest, onUpdated, onClose, onOpenInProject } = context
  const id = issue.id
  const { detail, comments, assignments, issues, members, agents, executions } = useMemo(
    () => ({
      detail: createAsyncResource(id, () => api.issues.get(id)),
      comments: createAsyncResource(id, () => api.comments.list(id)),
      assignments: createAsyncResource(id, () => api.assignments?.list(id) ?? Promise.resolve([])),
      issues: createAsyncResource(project.id, () => api.issues.list(project.id)),
      members: createAsyncResource(project.id, () => api.members.list(project.id)),
      agents: createAsyncResource(project.id, () => api.agents.list(project.id)),
      executions: createAsyncResource(id, async () => {
        const runs = await api.executions.list(project.id, { includeTerminal: true })
        return runs.filter(run => run.loop_item_id === id)
      }),
    }),
    [api, id, project.id]
  )
  const binding = useMemo(
    () =>
      createAsyncResource(taskRequest?.key ?? id, async () => {
        if (taskRequest?.binding) return taskRequest.binding
        const address = taskRequest?.address
        if (!address) return null
        const bindings = await api.taskBindings?.list(id, project.id)
        return (
          bindings?.find(
            item => item.deviceId === address.deviceId && item.taskId === address.taskId
          ) ?? null
        )
      }),
    [api, id, project.id, taskRequest]
  )
  const snapshot = useResource(detail, context.active)
  const accessible =
    context.active && snapshot.data != null && snapshot.data.can_view_detail !== false
  const commentSnapshot = useResource(comments, accessible)
  const assignmentSnapshot = useResource(assignments, accessible)
  const issueSnapshot = useResource(issues, accessible)
  const memberSnapshot = useResource(members, accessible)
  const agentSnapshot = useResource(agents, accessible)
  const executionSnapshot = useResource(executions, accessible)
  const taskSnapshot = useResource(binding, accessible && Boolean(taskRequest))
  const task = taskSnapshot.data
  const failedResources = [
    [detail, snapshot],
    [comments, commentSnapshot],
    [assignments, assignmentSnapshot],
    [issues, issueSnapshot],
    [members, memberSnapshot],
    [agents, agentSnapshot],
    [executions, executionSnapshot],
    [binding, taskSnapshot],
  ] as const
  const failures = failedResources.filter(([, current]) => current.status === 'error')
  const backToIssues = (
    <Button
      type="button"
      variant="ghost"
      className="min-h-11 justify-start md:hidden"
      data-testid="personal-home-back-to-issues"
      onClick={onClose}
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4" />
      {t('personalHome.backToIssues')}
    </Button>
  )
  const data = snapshot.data
  if (!data || data.can_view_detail === false) {
    if (snapshot.status === 'error' || data?.can_view_detail === false) {
      return (
        <div role="alert" className="p-4 text-sm">
          {t('personalHome.detailFailed')}
          <Button type="button" onClick={() => void detail.reload()}>
            {t('common.retry')}
          </Button>
          <Button type="button" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      )
    }
    return (
      <>
        {backToIssues}
        <div role="status" className="p-4 text-sm">
          {t('personalHome.loading')}
        </div>
        <Button
          type="button"
          className="hidden md:inline-flex"
          data-testid="personal-home-cancel-issue-load"
          onClick={onClose}
        >
          {t('common.close')}
        </Button>
      </>
    )
  }
  const update = (next: typeof data) => {
    detail.update(() => next)
    onUpdated({ ...issue, ...next })
  }
  return (
    <>
      {backToIssues}
      {taskRequest && taskSnapshot.status === 'ready' && !task && (
        <div className="flex items-center gap-2 px-3 text-sm" role="status">
          {t('personalHome.taskStatusUnknown')}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="personal-home-retry-task-binding"
            onClick={() => void binding.reload()}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {failures.length > 0 && (
        <div className="flex items-center gap-2 px-3 text-sm" role="alert">
          {t('personalHome.relatedFailed')}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="personal-home-detail-retry"
            onClick={() => {
              for (const [resource] of failures) void resource.reload()
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      <div className="issue-drawer-workspace relative flex min-h-0 flex-1 flex-col">
        <IssueDetail
          api={api}
          embedded
          panelExpansion={
            context.onDetailExpandedChange
              ? {
                  expanded: context.detailExpanded ?? false,
                  onChange: context.onDetailExpandedChange,
                  testId: 'personal-home-issue-expand',
                }
              : undefined
          }
          taskRequest={
            task && taskRequest
              ? { key: taskRequest.key, binding: toSharedIssueDetailTaskBinding(task) }
              : undefined
          }
          project={project}
          issue={data}
          allIssues={issueSnapshot.data ?? []}
          members={memberSnapshot.data ?? []}
          agents={agentSnapshot.data ?? []}
          executions={executionSnapshot.data ?? []}
          comments={commentSnapshot.data ?? []}
          assignments={assignmentSnapshot.data ?? []}
          messages={collaborationMessages[locale]}
          onClose={() => onClose?.()}
          onChange={update}
          onRead={update}
          onOpenRelatedIssue={context.onOpenIssue}
          onCommentsChange={next => comments.update(() => next)}
          onConflict={async () => {
            await detail.reload()
          }}
          onError={() => void detail.reload()}
          headerActions={
            onOpenInProject && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="personal-home-open-in-project"
                onClick={onOpenInProject}
              >
                <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                {t('personalHome.openInProject')}
              </Button>
            )
          }
        />
      </div>
    </>
  )
}

function useResource<T>(resource: ReturnType<typeof createAsyncResource<T>>, active: boolean) {
  return useSyncExternalStore(
    active ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    resource.getSnapshot
  )
}
