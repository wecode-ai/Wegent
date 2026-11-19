import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import {
  canStartWorkOnCollaborationIssue,
  toSharedIssueDetailTaskBinding,
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
  const source = useMemo(
    () =>
      createAsyncResource(
        'experience-issue-details',
        async () => {
          const [issues, assignments] = await Promise.all([
            owner.api.issues.list(owner.projectId),
            owner.api.assignments?.list(owner.issueId) ?? Promise.resolve(null),
          ])
          return {
            issues: issues.filter(
              issue =>
                issue.cloud_project_id === owner.projectId &&
                canStartWorkOnCollaborationIssue(issue)
            ),
            assignment:
              assignments
                ?.filter(
                  assignment =>
                    assignment.issue_id === owner.issueId && assignment.status === 'active'
                )
                .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
                .at(-1) ?? null,
          }
        },
        { refreshOnSubscribe: true }
      ),
    [owner]
  )
  const version = useMemo(() => ({ revision, chatClient }), [revision, chatClient])
  const subscribe = useCallback(
    (notify: () => void) =>
      active && chatClient ? source.subscribe(notify, version) : subscribeIdleResource(),
    [source, active, chatClient, version]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  const current = snapshot.data
  const error = !chatClient
    ? t('unavailable')
    : snapshot.error === undefined
      ? null
      : snapshot.error instanceof Error
        ? snapshot.error.message
        : String(snapshot.error)
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
            onClick={() => {
              if (active && chatClient) void source.reload()
            }}
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
