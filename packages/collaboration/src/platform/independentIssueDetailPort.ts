import type { SharedIssueDetailPort } from '../issue-detail/createSharedIssueDetailPort'
import { createIssueAttachmentPort } from '../issue-detail/createIssueAttachmentPort'
import type { CollaborationProject } from '../types'
import type { SharedWorkspaceAttachmentsApi } from '../ports/SharedWorkspaceApi'
import type { PersonalIssuesApi } from './personalIssuesApi'

export function createIndependentIssueDetailPort(
  state: Pick<
    ReturnType<typeof import('./independentIssueDialogState').createIndependentIssueDialogState>,
    'getSnapshot' | 'updateDetail' | 'addParticipant' | 'removeParticipant'
  >,
  api: PersonalIssuesApi<CollaborationProject>,
  saveAttachment: (blob: Blob, filename: string) => Promise<unknown>,
  listTaskBindings?: SharedIssueDetailPort['taskBindings']['list'],
  attachmentApi?: SharedWorkspaceAttachmentsApi,
  canManageParticipants = false
): SharedIssueDetailPort {
  const unavailable = async () => {
    throw new Error('Operation unavailable in the independent Issue detail view')
  }
  const empty = async () => []
  return {
    issues: {
      get: api.issueDetail,
      create: async (projectId, input) => {
        if (projectId || !input.parent_id) throw new Error('Issue context is unavailable')
        const assignee = input.assignee_user_id ?? null
        const resource = input.assignee_agent_id
          ? { kind: 'agent' as const, id: Number(input.assignee_agent_id) }
          : input.assignee_group_id
            ? { kind: 'group' as const, id: Number(input.assignee_group_id) }
            : null
        const child = await api.create({
          parent_id: input.parent_id,
          request_id: input.request_id,
          title: input.title,
          description: input.description ?? '',
          status: 'pending',
          priority: input.priority && input.priority !== 'none' ? input.priority : 'medium',
          assignee_id: assignee,
          participants: assignee === null ? [] : [assignee],
          assignee_resource: resource,
          resource_participants: resource ? [resource] : [],
          archived: false,
          due_at: null,
        })
        return api.issueDetail(child.id)
      },
      update: async (id, input) => (await state.updateDetail(id, input)).detail,
    },
    attachments: createIssueAttachmentPort({
      api: attachmentApi,
      saveFile: saveAttachment,
    }),
    collaborators: {
      canEdit: canManageParticipants,
      searchUsers: canManageParticipants
        ? async query =>
            (await api.searchUsers(query)).users.map(user => ({ ...user, email: null }))
        : undefined,
      list: api.collaborators,
      add: canManageParticipants ? state.addParticipant : unavailable,
      remove: canManageParticipants ? state.removeParticipant : unavailable,
    },
    taskBindings: { list: listTaskBindings ?? empty },
    members: {
      list: async () => {
        const { issue } = state.getSnapshot()
        if (!issue) return []
        return [...new Set([issue.creator_id, ...issue.metadata.participants])].map(userId => ({
          id: userId,
          user_id: userId,
          user_name: issue.people[userId] ?? `#${userId}`,
          email: null,
          role: 'Viewer',
          can_be_assignee: true,
        }))
      },
    },
    agents: { list: empty },
    collaborationGroups: { list: empty },
    deliveries: { list: empty, get: unavailable },
  }
}
