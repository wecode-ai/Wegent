import type { HttpClient } from './http'
import type { CloudProject } from './deliveries'

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
export interface IndependentIssueComment {
  id: string
  author_id: number
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

export function createPersonalIssuesApi(client: HttpClient) {
  return {
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
    projects(): Promise<{ items: CloudProject[] }> {
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
export type PersonalIssuesApi = ReturnType<typeof createPersonalIssuesApi>
