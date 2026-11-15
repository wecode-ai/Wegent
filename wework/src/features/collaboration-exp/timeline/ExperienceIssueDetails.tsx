import { useEffect, useMemo, useState } from 'react'
import {
  canStartWorkOnCollaborationIssue,
  toSharedIssueDetailTaskBinding,
  type CollaborationAssignment,
  type CollaborationIssue,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { CloudLoopItem, CloudProject, LoopItemTaskBinding } from '@/api/deliveries'
import { Button } from '@/components/ui/button'
import { TodoEditor } from '@/features/todo/TodoEditor'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { getRuntimeWorkDeviceNamesById, getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import type { ExperienceIssueData } from '../data/useExperienceIssue'

interface Props {
  api: SharedWorkspaceApi
  data: ExperienceIssueData
  active: boolean
  revision: number
  onClose(): void
  onChange(issue: CollaborationIssue): void
}

/** The existing desktop editor retains its native activity and permission boundaries. */
export function ExperienceIssueDetails({ api, data, active, revision, onClose, onChange }: Props) {
  const { state, services } = useWorkbench()
  const { t } = useTranslation('collaborationExp')
  const [request, setRequest] = useState(0)
  const detailServices =
    services.projectSpaceDetailServices?.[
      data.project.project_store === 'local' ? 'local' : 'cloud'
    ]
  const chatClient = detailServices?.projectChatClient
  const owner = useMemo(
    () => ({
      api,
      store: data.project.project_store,
      projectId: data.project.id,
      issueId: data.issue.id,
    }),
    [api, data.project.project_store, data.project.id, data.issue.id]
  )
  const [snapshot, setSnapshot] = useState<{
    owner: typeof owner
    issues: CollaborationIssue[] | null
    assignment: CollaborationAssignment | null
    error: string | null
  }>({ owner, issues: null, assignment: null, error: null })
  const current = snapshot.owner === owner ? snapshot : null
  useEffect(() => {
    if (!active || !chatClient) return
    let cancelled = false
    void Promise.all([
      api.issues.list(owner.projectId),
      api.assignments?.list(owner.issueId) ?? Promise.resolve(null),
    ]).then(
      ([issues, assignments]) => {
        if (cancelled) return
        setSnapshot({
          owner,
          issues: issues.filter(
            issue =>
              issue.cloud_project_id === owner.projectId && canStartWorkOnCollaborationIssue(issue)
          ),
          assignment:
            assignments
              ?.filter(
                assignment =>
                  assignment.issue_id === owner.issueId && assignment.status === 'active'
              )
              .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
              .at(-1) ?? null,
          error: null,
        })
      },
      cause => {
        if (!cancelled)
          setSnapshot(previous => ({
            owner,
            issues: previous.owner === owner ? previous.issues : null,
            assignment: previous.owner === owner ? previous.assignment : null,
            error: cause instanceof Error ? cause.message : String(cause),
          }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [api, owner, active, chatClient, revision, request])
  const error = !chatClient ? t('unavailable') : current?.error
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="collaboration-exp-issue-details"
    >
      {error && (
        <div role="alert" className="border-b border-border px-4 py-3 text-sm text-error">
          <p>{error}</p>
          <Button
            variant="ghost"
            data-testid="collaboration-exp-issue-details-retry"
            onClick={() => setRequest(value => value + 1)}
          >
            {t('retry')}
          </Button>
        </div>
      )}
      {!current?.issues && !error && (
        <p role="status" className="p-4 text-sm text-text-muted">
          {t('loading')}
        </p>
      )}
      {current?.issues && chatClient && (
        <TodoEditor
          key={`${owner.store}:${owner.projectId}:${owner.issueId}`}
          mode="edit"
          sharedApi={api}
          presentation="workspace-panel"
          workspacePanelFill
          readFirst
          showPanelControls={false}
          showFullscreenControl={false}
          showChildren={false}
          item={data.issue as CloudLoopItem}
          project={
            {
              ...data.project,
              location: owner.store === 'local' ? 'local' : 'cloud',
            } as unknown as CloudProject
          }
          allItems={current.issues as CloudLoopItem[]}
          currentUserId={data.project.current_user_id ?? state.user?.id}
          currentAssignment={current.assignment}
          localProjects={state.projects}
          projectChatClient={active ? chatClient : undefined}
          projectChatAgentApi={detailServices?.projectChatAgentApi}
          teamApi={detailServices?.teamApi ?? services.teamApi}
          selfManagedExecution={owner.store === 'local'}
          getRuntimeTranscript={services.runtimeWorkApi?.getRuntimeTranscript}
          taskRefreshKey={revision}
          initialTaskBindings={
            data.taskBindings.map(toSharedIssueDetailTaskBinding) as LoopItemTaskBinding[]
          }
          deviceNamesById={{
            ...getWorkbenchDeviceNamesById(state.devices ?? []),
            ...getRuntimeWorkDeviceNamesById(state.runtimeWork),
          }}
          aitableApi={
            data.project.task_provider === 'dingtalk_aitable' ? services.aitableApi : undefined
          }
          onClose={onClose}
          onUpdated={issue => onChange(issue as CollaborationIssue)}
          onRead={issue => onChange(issue as CollaborationIssue)}
        />
      )}
    </section>
  )
}
