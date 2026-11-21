import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

export interface PersonalIssueTransport {
  get<T>(endpoint: string, options?: { signal?: AbortSignal }): Promise<T>
  getBlob(endpoint: string): Promise<Blob>
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
  human_ids: number[]
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
  excerpts: Pick<WorkbenchMessage, 'id' | 'role' | 'content'>[]
  historyUnavailable?: boolean
  history?: {
    earlier(cursor?: string): Promise<{
      excerpts: TaskIssueShareDraft['excerpts']
      beforeCursor: string | null
    }>
  }
}

export interface SharedIssueAttachment {
  id: string
  filename: string
  size: number
}

export interface IndependentIssue {
  id: string
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
  metadata: {
    share?: { files: SharedIssueAttachment[] } | null
    standalone: true
    participants: number[]
    direct_participants?: number[] | null
    resource_participants?: IssueResourceParticipant[]
    assignee_resource?: IssueResourceInvitation | null
    archived: boolean
    due_at: string | null
  }
}
export interface IndependentIssueInput {
  title: string
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

export async function resolveMovedPersonalIssue(
  reason: unknown,
  readProjectIssue: () => Promise<{ cloud_project_id?: string | number | null; can_view_detail?: boolean }>
): Promise<string | null> {
  if (!(reason instanceof Error) || !('status' in reason) || reason.status !== 404) return null
  const issue = await readProjectIssue().catch(() => null)
  return issue?.cloud_project_id && issue.can_view_detail !== false
    ? String(issue.cloud_project_id)
    : null
}

export interface IssueCreationInput extends IndependentIssueInput {
  project_id?: string
  project_status?: string
}
export interface IndependentIssueComment {
  id: string
  author_id: number
  assistant_name?: string
  body: string
  created_at: string
}
export interface IndependentIssuePage {
  items: IndependentIssue[]
  next_cursor: string | null
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
  return {
    assignmentCount(signal?: AbortSignal): Promise<{ count: number }> {
      return client.get('/v1/me/issue-assignment-count', { signal })
    },
    list(
      scope: PersonalIssueScope,
      includeCompleted: boolean,
      cursor?: string,
      archived = false,
      order: PersonalIssueOrder = 'attention'
    ): Promise<IndependentIssuePage> {
      const query = new URLSearchParams({
        scope,
        include_completed: String(includeCompleted),
        archived: String(archived),
        order,
      })
      if (cursor) query.set('cursor', cursor)
      return client.get(`/v1/personal-issues?${query}`)
    },
    get(id: string): Promise<IndependentIssue> {
      return client.get(`/v1/personal-issues/${encodeURIComponent(id)}`)
    },
    create(input: IndependentIssueInput): Promise<IndependentIssue> {
      return client.post('/v1/personal-issues', input)
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
    sharedAttachment(id: string, attachmentId: string): Promise<Blob> {
      return client.getBlob(
        `/v1/personal-issues/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`
      )
    },
    update(id: string, input: IndependentIssueInput): Promise<IndependentIssue> {
      return client.patch(`/v1/personal-issues/${encodeURIComponent(id)}`, input)
    },
    remove(id: string, version: number): Promise<void> {
      return client.delete(`/v1/personal-issues/${encodeURIComponent(id)}`, { version })
    },
    comments(id: string): Promise<IndependentIssueComment[]> {
      return client.get(`/v1/personal-issues/${encodeURIComponent(id)}/comments`)
    },
    comment(id: string, body: string): Promise<{ id: string }> {
      return client.post(`/v1/personal-issues/${encodeURIComponent(id)}/comments`, { body })
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
export type PersonalIssuesApi<Project = unknown> = ReturnType<typeof createPersonalIssuesApi<Project>>
