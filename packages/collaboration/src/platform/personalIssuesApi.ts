import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type {
  SharedIssueDetailCollaborator,
  SharedIssueDetailUpdateInput,
} from '../issue-detail/createSharedIssueDetailPort'
import type { CollaborationIssue, SharedIssueStatusHistoryEntry } from '../types'
import type { WorkspaceMyWorkItem } from '../ports/SharedWorkspaceApi'
import { mapWorkspaceTaskBindingDto } from '../dto-mappers/workspaceDtoMappers'

export interface PersonalIssueTransport {
  get<T>(endpoint: string, options?: { signal?: AbortSignal }): Promise<T>
  post<T>(endpoint: string, input: unknown): Promise<T>
  patch<T>(endpoint: string, input: unknown): Promise<T>
  delete<T>(endpoint: string, input: unknown): Promise<T>
}

export type PersonalIssueOrder = 'attention' | 'activity' | 'assignment' | 'priority'
export type PersonalIssueScope = 'assigned' | 'created' | 'participating'
export interface IssueResourceInvitation {
  kind: 'agent' | 'group'
  id: number
}
export interface IssueResourceParticipant extends IssueResourceInvitation {
  name: string
  instructions?: string
  team_id: number | null
  human_ids?: number[]
}
export interface SharedIssueSource {
  device_id: string
  task_id: string
  title: string
}

export interface SharedIssueTarget {
  id: string
  title: string
  project_id: string | null
  restricted: boolean
}

export type TaskIssueConversationFile = {
  id: string
  name: string
  load(): Promise<File>
}

export type TaskIssueShareDraft = {
  title: string
  requestId: string
  source: SharedIssueSource
  conversationFiles: TaskIssueConversationFile[]
  excerpts: (Pick<WorkbenchMessage, 'id' | 'role' | 'content'> & {
    order?: [turnPosition: number, itemPosition: number]
  })[]
  selectedExcerpt?: {
    excerpt: TaskIssueShareDraft['excerpts'][number]
    start: number
    end: number
    followingMessageIds: string[]
  }
  historyUnavailable?: boolean
  history?: {
    earlier(cursor?: string): Promise<{
      excerpts: TaskIssueShareDraft['excerpts']
      beforeCursor: string | null
    }>
  }
}

export interface IndependentIssue {
  id: string
  parent_id?: string | null
  title: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  creator_id: number
  assignee_id: number | null
  version: number
  created_at: string
  updated_at: string
  people: Record<string, string>
  detail?: IssueDetailResponse
  metadata: {
    participants: number[]
    direct_participants?: number[] | null
    resource_participants?: IssueResourceParticipant[]
    assignee_resource?: IssueResourceInvitation | null
    archived: boolean
    status_history?: SharedIssueStatusHistoryEntry[]
    due_at: string | null
    share?: Record<string, unknown> | null
  }
}

export interface IssueDetailResponse extends CollaborationIssue {
  related_issues?: CollaborationIssue[]
  edit_context?: {
    participants: { user_id: number; user_name: string | null; direct: boolean }[]
    resources: IssueResourceParticipant[]
    archived: boolean
    has_shared_source: boolean
  } | null
}
export interface IndependentIssueInput {
  title: string
  parent_id?: string
  request_id?: string
  description: string
  status: IndependentIssue['status']
  priority: IndependentIssue['priority']
  assignee_id: number | null
  participants: number[]
  resource_participants?: IssueResourceInvitation[]
  assignee_resource?: IssueResourceInvitation | null
  archived: boolean
  due_at: string | null
  version?: number
}

export function detailProjectId(
  issue: Pick<CollaborationIssue, 'cloud_project_id' | 'can_view_detail'>
) {
  return issue.cloud_project_id && issue.can_view_detail !== false
    ? String(issue.cloud_project_id)
    : null
}

export function unlinkedIssueFromDetail(
  detail: IssueDetailResponse
): IndependentIssue & { detail: IssueDetailResponse } {
  const context = detail.edit_context
  if (detail.cloud_project_id || !context || detail.can_view_detail === false)
    throw Object.assign(new Error('Issue not found'), { status: 404 })
  const people: Record<string, string> = {}
  if (detail.created_by_user_name) people[detail.created_by_user_id] = detail.created_by_user_name
  for (const person of context.participants) {
    if (person.user_name != null) people[person.user_id] = person.user_name
  }
  const group = detail.assignee_group_id
  const agent = detail.assignee_agent_id
  return {
    id: detail.id,
    parent_id: detail.parent_id,
    title: detail.title,
    description: detail.description,
    status: detail.status as IndependentIssue['status'],
    priority: detail.priority as IndependentIssue['priority'],
    creator_id: detail.created_by_user_id,
    assignee_id: detail.assignee_user_id,
    version: detail.version,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    people,
    detail,
    metadata: {
      participants: context.participants.map(person => person.user_id),
      direct_participants: context.participants
        .filter(person => person.direct)
        .map(person => person.user_id),
      resource_participants: context.resources,
      assignee_resource: group
        ? { kind: 'group', id: Number(group) }
        : agent
          ? { kind: 'agent', id: Number(agent) }
          : null,
      archived: context.archived,
      due_at: detail.due_at?.slice(0, 10) ?? null,
      status_history: detail.status_history,
      share: context.has_shared_source ? {} : null,
    },
  }
}

export interface IssueCreationInput extends IndependentIssueInput {
  project_id?: string
  project_status?: string
}
export function independentIssueInput(issue: IndependentIssue): IndependentIssueInput {
  return {
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    assignee_id: issue.assignee_id,
    participants: issue.metadata.direct_participants ?? issue.metadata.participants,
    resource_participants: (issue.metadata.resource_participants ?? []).map(({ kind, id }) => ({
      kind,
      id,
    })),
    assignee_resource: issue.metadata.assignee_resource ?? null,
    archived: issue.metadata.archived,
    due_at: issue.metadata.due_at,
    version: issue.version,
  }
}

export function createPersonalIssuesApi<Project>(client: PersonalIssueTransport) {
  const issueDetail = (id: string): Promise<IssueDetailResponse> =>
    client.get(`/v1/loop-items/${encodeURIComponent(id)}`)
  return {
    assignmentCount(signal?: AbortSignal): Promise<{ count: number }> {
      return client.get('/v1/me/issue-assignment-count', { signal })
    },
    async list(
      scope: PersonalIssueScope,
      includeCompleted: boolean,
      cursor?: string,
      archived = false,
      order: PersonalIssueOrder = 'attention'
    ): Promise<{ items: WorkspaceMyWorkItem[]; next_cursor: string | null }> {
      const query = new URLSearchParams({
        scope,
        include_completed: String(includeCompleted),
        archived: String(archived),
        unlinked: 'true',
        order,
      })
      if (cursor) query.set('cursor', cursor)
      const page = await client.get<{
        items: (Omit<WorkspaceMyWorkItem, 'task_bindings'> & { task_bindings: object[] })[]
        next_cursor: string | null
      }>(`/v1/cloud-work-items/my-work?${query}`)
      return {
        ...page,
        items: page.items
          .filter(item => !item.cloud_project_id)
          .map(item => ({
            ...item,
            task_bindings: item.task_bindings.map(binding =>
              mapWorkspaceTaskBindingDto(binding, '')
            ),
          })),
      }
    },
    issueDetail,
    updateDetail(
      id: string,
      fields: Pick<
        SharedIssueDetailUpdateInput,
        | 'version'
        | 'title'
        | 'description'
        | 'due_at'
        | 'priority'
        | 'status'
        | 'assignee_user_id'
        | 'assignee_agent_id'
        | 'assignee_group_id'
        | 'assignee_team_id'
        | 'notify_assignee'
      > & { archived?: boolean }
    ): Promise<IndependentIssue & { detail: IssueDetailResponse }> {
      return client
        .patch<IssueDetailResponse>(`/v1/loop-items/${encodeURIComponent(id)}`, fields)
        .then(unlinkedIssueFromDetail)
    },
    create(input: IndependentIssueInput): Promise<IndependentIssue> {
      return client.post('/v1/loop-items', { issue: input })
    },
    createInProject(
      input: IndependentIssueInput,
      projectId: string,
      projectStatus: string | undefined,
      requestId: string
    ): Promise<{ project_id: string; issue_id: string }> {
      return client.post('/v1/loop-items', {
        issue: input,
        project_id: projectId,
        project_status: projectStatus || undefined,
        request_id: requestId,
      })
    },
    createShared(
      requestId: string,
      source: SharedIssueSource,
      issue: IndependentIssueInput,
      files: File[],
      projectId?: string,
      projectStatus?: string
    ): Promise<SharedIssueTarget> {
      const form = new FormData()
      form.append(
        'metadata',
        JSON.stringify({
          request_id: requestId,
          source,
          issue,
          project_id: projectId,
          project_status: projectStatus,
        })
      )
      for (const file of files) form.append('file', file)
      return client.post('/v1/personal-issues/share', form)
    },
    sharedFrom(
      source: Pick<SharedIssueSource, 'device_id' | 'task_id'>
    ): Promise<SharedIssueTarget[]> {
      const query = new URLSearchParams(source)
      return client.get(`/v1/personal-issues/shared-from?${query}`)
    },
    sharedSource(id: string): Promise<SharedIssueSource> {
      return client.get(`/v1/personal-issues/${encodeURIComponent(id)}/source`)
    },
    updateWithParticipants(id: string, input: IndependentIssueInput): Promise<IndependentIssue> {
      return client.patch(`/v1/personal-issues/${encodeURIComponent(id)}`, input)
    },
    remove(id: string, version: number): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(id)}`, { version })
    },
    comments(id: string): Promise<ProjectChatMessage[]> {
      return client.get(`/v1/personal-issues/${encodeURIComponent(id)}/comments?view=message`)
    },
    collaborators(id: string): Promise<SharedIssueDetailCollaborator[]> {
      return client.get(`/v1/loop-items/${encodeURIComponent(id)}/collaborators`)
    },
    addCollaborator(id: string, userId: number): Promise<SharedIssueDetailCollaborator> {
      return client.post(`/v1/loop-items/${encodeURIComponent(id)}/collaborators`, {
        user_id: userId,
      })
    },
    removeCollaborator(id: string, userId: number): Promise<void> {
      return client.delete(
        `/v1/loop-items/${encodeURIComponent(id)}/collaborators/${userId}`,
        undefined
      )
    },
    comment(id: string, body: string, mentionedUsers: number[] = []): Promise<{ id: string }> {
      return client.post(`/v1/personal-issues/${encodeURIComponent(id)}/comments`, {
        body,
        ...(mentionedUsers.length ? { mentioned_user_ids: mentionedUsers } : {}),
      })
    },
    projects(): Promise<{ items: Project[] }> {
      return client.get('/v1/cloud-projects')
    },
    associate(
      id: string,
      projectId: string,
      version: number,
      status: string
    ): Promise<{ project_id: string; issue_id: string }> {
      return client.post(`/v1/personal-issues/${encodeURIComponent(id)}/project`, {
        project_id: projectId,
        version,
        status,
      })
    },
    processingResource(
      issueId: string,
      kind: 'agent' | 'group',
      resourceId: number
    ): Promise<{ name: string; team_id: number | null; instructions: string }> {
      return client.get(
        `/v1/personal-issues/${encodeURIComponent(issueId)}/resources/${kind}/${resourceId}`
      )
    },
    searchUsers(query: string): Promise<{ users: Array<{ id: number; user_name: string }> }> {
      return client.get(`/users/search?q=${encodeURIComponent(query)}&limit=20`)
    },
  }
}
export type PersonalIssuesApi<Project = unknown> = ReturnType<
  typeof createPersonalIssuesApi<Project>
>
