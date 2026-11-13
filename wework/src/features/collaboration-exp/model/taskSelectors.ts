import {
  canStartWorkOnCollaborationIssue,
  issueHumanAssignees,
  issueNeedsUser,
  issueParticipation,
  issueWaitingSince,
  standInProcessingActor,
} from '@wegent/collaboration'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import type {
  CollaborationIssue,
  IssueParticipationViewer,
  WorkspaceIssueCollaborator,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import { selectPrivateConversations } from './conversationSelectors'
import { runtimeTaskSummaryTrackingExecutionStatus } from '@/features/workbench/runtimeTaskLifecycle/projection'
import { matchesExperienceViewer, projectScopeOf, projectViewer } from './sourceIdentity'
import type {
  ExperienceIssueSource,
  ExperienceConversationSelection,
  ExperienceProjectData,
  ExperienceProjectSummary,
  ExperienceReadModelInput,
  ExperienceTaskFilter,
  ExperienceTaskRow,
} from './types'

interface TaskSource {
  project: ExperienceProjectData['project']
  participationViewer?: IssueParticipationViewer
  issue: ExperienceIssueSource
  taskBindings: WorkspaceTaskBinding[] | undefined
  collaborators: readonly WorkspaceIssueCollaborator[]
}

export function isExperienceIssueRelatedToViewer(
  issue: CollaborationIssue,
  viewer: IssueParticipationViewer,
  collaborators: readonly WorkspaceIssueCollaborator[] = []
): boolean {
  return (
    issueNeedsUser(issue, viewer) ||
    (issue.assignee_user_id != null && matchesExperienceViewer(issue.assignee_user_id, viewer)) ||
    collaborators.some(
      row =>
        row.issueId === issue.id &&
        row.source === 'manual' &&
        matchesExperienceViewer(row.userId, viewer)
    )
  )
}

function issueSources(input: ExperienceReadModelInput): Map<string, TaskSource> {
  const sources = new Map<string, TaskSource>()
  for (const source of input.projects)
    for (const issue of source.issues) {
      if (issue.cloud_project_id !== source.project.id) continue
      const key = JSON.stringify([source.project.project_store, source.project.id, issue.id])
      const previous = sources.get(key)
      const candidateBindings =
        source.taskBindings || issue.task_bindings
          ? [...(source.taskBindings ?? []), ...(issue.task_bindings ?? [])]
          : undefined
      const bindings =
        candidateBindings || previous?.taskBindings
          ? [...(previous?.taskBindings ?? []), ...(candidateBindings ?? [])]
          : undefined
      const selected =
        !previous ||
        issue.version > previous.issue.version ||
        (issue.version === previous.issue.version &&
          (issue.can_view_detail === false ||
            (previous.issue.can_view_detail !== false &&
              issue.updated_at >= previous.issue.updated_at)))
          ? { project: source.project, participationViewer: source.participationViewer, issue }
          : previous
      sources.set(key, {
        ...selected,
        taskBindings: bindings,
        collaborators: [...(previous?.collaborators ?? []), ...(source.collaborators ?? [])],
      })
    }
  return sources
}

function taskRow(
  key: string,
  source: TaskSource,
  input: ExperienceReadModelInput
): ExperienceTaskRow {
  const { project, issue } = source
  const viewer = projectViewer(project, input.viewer, source.participationViewer)
  const conversations = selectPrivateConversations({
    ...source,
    viewer,
    runtimeWork: input.runtimeWork,
  })
  const participationIssue = issueWithRuntimeExecution(source, input, conversations)
  return {
    key,
    id: issue.id,
    project: projectScopeOf(project),
    title: issue.title,
    status: issue.status,
    statusName:
      project.board_config?.statuses.find(status => status.id === issue.status)?.name ??
      issue.status,
    priority: issue.priority,
    assignee:
      issue.assignee_user_id == null
        ? null
        : { id: issue.assignee_user_id, name: issue.assignee_name ?? null },
    needsUser: issueNeedsUser(participationIssue, viewer),
    waitingSince: issueWaitingSince(participationIssue, viewer),
    waitingFor:
      issueParticipation(participationIssue) === 'human'
        ? issueHumanAssignees(participationIssue).filter(
            (person, index, people) =>
              people.findIndex(candidate => candidate.id === person.id) === index
          )
        : [],
    executionState:
      participationIssue.execution_state ?? participationIssue.ai_state?.status ?? null,
    completedAt: issue.completed_at,
    updatedAt: issue.updated_at,
    conversations,
  }
}

function issueWithRuntimeExecution(
  { project, issue }: TaskSource,
  input: ExperienceReadModelInput,
  conversations: ExperienceConversationSelection
): CollaborationIssue {
  if (issue.completed_at || ['completed', 'cancelled', 'archived'].includes(issue.status))
    return issue
  const runtimeOwner = typeof input.viewer === 'object' ? project.current_user_id : input.viewer
  if (runtimeOwner == null) return issue
  let queued: CollaborationIssue | undefined
  for (const conversation of conversations.items) {
    const task = findRuntimeTask(input.runtimeWork, conversation.address)
    const origin = task?.runtimeHandle?.origin as Record<string, unknown> | undefined
    const originStore = origin?.projectStore === 'cloud' ? 'backend' : origin?.projectStore
    if (
      !task ||
      origin?.initiatedBy !== 'stand_in' ||
      originStore !== project.project_store ||
      origin.cloudProjectId !== project.id ||
      origin.loopItemId !== issue.id ||
      String(origin.userId) !== String(runtimeOwner) ||
      (project.project_store !== 'local' &&
        String(conversation.ownerUserId) !== String(runtimeOwner))
    )
      continue
    const execution = runtimeTaskSummaryTrackingExecutionStatus(task)
    if (execution !== 'running' && execution !== 'queued') continue
    const projected = {
      ...issue,
      execution_state: execution,
      processing_actor: standInProcessingActor(task.runtimeHandle, true) ?? issue.processing_actor,
    }
    if (execution === 'running') return projected
    queued ??= projected
  }
  return queued ?? issue
}

export function selectTaskRows(
  input: ExperienceReadModelInput,
  filter: ExperienceTaskFilter = {}
): ExperienceTaskRow[] {
  const rows: ExperienceTaskRow[] = []
  const search = filter.search?.trim().toLocaleLowerCase()
  for (const [key, source] of issueSources(input)) {
    if (!canStartWorkOnCollaborationIssue(source.issue)) continue
    const row = taskRow(key, source, input)
    const relatedToViewer = isExperienceIssueRelatedToViewer(
      source.issue,
      projectViewer(source.project, input.viewer, source.participationViewer),
      source.collaborators
    )
    if ((filter.relevance ?? 'related') === 'related' && !relatedToViewer) continue
    if (filter.projectKey && row.project.key !== filter.projectKey) continue
    if (filter.statuses?.length && !filter.statuses.includes(row.status)) continue
    if (
      search &&
      ![row.id, row.title, row.project.name].some(value =>
        value.toLocaleLowerCase().includes(search)
      )
    )
      continue
    rows.push(row)
  }
  return rows
}

export function selectProjectScopes(input: ExperienceReadModelInput): ExperienceProjectSummary[] {
  const visible = selectTaskRows(input, { relevance: 'all' })
  const projects = new Map<string, ExperienceProjectSummary>()
  for (const source of input.projects) {
    const scope = projectScopeOf(source.project)
    if (!projects.has(scope.key))
      projects.set(scope.key, { ...scope, taskCount: 0, needsUserCount: 0 })
  }
  for (const row of visible) {
    const project = projects.get(row.project.key)!
    project.taskCount += 1
    project.needsUserCount += Number(row.needsUser)
  }
  return [...projects.values()]
}
