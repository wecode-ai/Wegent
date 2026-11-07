import type { IssueHumanRequest } from '@wegent/collaboration'
import type { HttpClient } from './http'
import type { LocalParticipationIdentity } from '@/features/workbench/workbenchServices'

export interface IssueHumanRequestsApi {
  inbox(viewerUserIds?: readonly number[]): Promise<{ items: IssueHumanRequest[] }>
  list(projectId: string, issueId: string): Promise<{ items: IssueHumanRequest[] }>
  assign(
    projectId: string,
    issueId: string,
    request: IssueHumanRequest,
    recipient: { id: number; name: string }
  ): Promise<IssueHumanRequest>
}

export function createIssueHumanRequestsApi(client: HttpClient): IssueHumanRequestsApi {
  return {
    inbox: () => client.get('/v1/wework-human-requests'),
    list: (_project, issue) =>
      client.get(`/v1/loop-items/${encodeURIComponent(issue)}/human-requests`),
    assign: (_project, issue, request, recipient) =>
      client.put(
        `/v1/loop-items/${encodeURIComponent(issue)}/human-requests/${encodeURIComponent(request.id)}`,
        {
          version: request.version,
          recipient_user_id: recipient.id,
          blocks_progress: request.blocks_progress,
        }
      ),
  }
}

export function createLocalIssueHumanRequestsApi(
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  identity: LocalParticipationIdentity
): IssueHumanRequestsApi {
  const capabilities = (item: IssueHumanRequest): IssueHumanRequest => ({
    ...item,
    can_assign: item.can_assign ?? true,
    can_reply: item.status === 'pending' && item.recipient_user_id === identity.currentUser.id,
  })
  return {
    async inbox(viewerUserIds = identity.viewerUserIds) {
      if (viewerUserIds.some(id => !identity.viewerUserIds.includes(id)))
        throw new Error('Local question inbox identity does not match this session')
      const result = await request<{ items: IssueHumanRequest[] }>('todos.humanRequests.inbox', {
        user_ids: [...new Set(viewerUserIds)],
      })
      return { ...result, items: result.items.map(capabilities) }
    },
    async list(project, issue) {
      const result = await request<{ items: IssueHumanRequest[] }>('todos.humanRequests.list', {
        project_id: project,
        task_id: issue,
      })
      return { ...result, items: result.items.map(capabilities) }
    },
    async assign(project, issue, item, recipient) {
      return capabilities(
        await request<IssueHumanRequest>('todos.humanRequests.assign', {
          project_id: project,
          task_id: issue,
          request_id: item.id,
          version: item.version,
          recipient_user_id: recipient.id,
          recipient_name: recipient.name,
          blocks_progress: item.blocks_progress,
        })
      )
    },
  }
}
