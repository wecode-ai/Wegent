import type { HttpClient } from './http'
import type { CollaborationProject } from '@wegent/collaboration'

export type GroupConfiguration = Pick<
  CollaborationProject,
  | 'board_config'
  | 'board_views'
  | 'card_display'
  | 'tags'
  | 'collaboration_groups'
  | 'automatic_processing_rules'
  | 'execution_environment'
>

export interface ChatGroupMember {
  user_id: number
  name: string
  role: 'Owner' | 'Maintainer' | 'Developer' | 'Viewer'
}

export interface ChatGroup {
  id: string
  project_key: string
  name: string
  description: string
  status: 'active' | 'archived'
  version: number
  role: ChatGroupMember['role']
  created_by_user_id: number
  created_at: string
  updated_at: string
  configuration?: Partial<GroupConfiguration>
}

export interface ThreadParticipation {
  current_user_id: number
  participants: Array<{ user_id: number; name: string; notifications: 'all' | 'muted' }>
  joined: boolean
  can_comment: boolean
  show_in_sidebar: boolean
}

export interface ThreadProjectLink {
  thread_version: number
  project: { id: string; name: string } | null
  restricted: boolean
}

export interface ChatGroupCreate {
  name: string
  description?: string
  member_ids?: number[]
}

export interface ChatGroupApi {
  inviteParticipants(threadId: string, userIds: number[]): Promise<ThreadParticipation>
  projectLink(threadId: string): Promise<ThreadProjectLink>
  setProjectLink(
    threadId: string,
    version: number,
    projectId: string | null
  ): Promise<ThreadProjectLink>
  addMember(
    groupId: string,
    userId: number,
    role: Exclude<ChatGroupMember['role'], 'Owner'>
  ): Promise<{ items: ChatGroupMember[] }>
  removeMember(groupId: string, userId: number): Promise<void>
  navigation(): Promise<{
    items: Array<{ id: string; group_id: string; title: string; status: string }>
  }>
  list(): Promise<{ items: ChatGroup[] }>
  create(input: ChatGroupCreate): Promise<{ group: ChatGroup; members: ChatGroupMember[] }>
  get(id: string): Promise<{ group: ChatGroup; members: ChatGroupMember[] }>
  update(
    id: string,
    input: Pick<ChatGroup, 'name' | 'description' | 'status' | 'version'> & {
      configuration?: Partial<GroupConfiguration>
    }
  ): Promise<{ group: ChatGroup }>
  participation(threadId: string): Promise<ThreadParticipation>
  setParticipation(
    threadId: string,
    input: { joined: boolean; notifications?: 'all' | 'muted' }
  ): Promise<ThreadParticipation>
}

export function createChatGroupApi(client: HttpClient): ChatGroupApi {
  return {
    inviteParticipants: (id, user_ids) =>
      client.post(`/v1/loop-items/${encodeURIComponent(id)}/participants`, { user_ids }),
    projectLink: id => client.get(`/v1/loop-items/${encodeURIComponent(id)}/project-link`),
    setProjectLink: (id, version, project_id) =>
      client.put(`/v1/loop-items/${encodeURIComponent(id)}/project-link`, { version, project_id }),
    addMember: (id, user_id, role) =>
      client.post(`/v1/chat-groups/${encodeURIComponent(id)}/members`, { user_id, role }),
    removeMember: (id, userId) =>
      client.delete(`/v1/chat-groups/${encodeURIComponent(id)}/members/${userId}`),
    navigation: () => client.get('/v1/chat-group-navigation'),
    list: () => client.get('/v1/chat-groups'),
    create: input => client.post('/v1/chat-groups', input),
    get: id => client.get(`/v1/chat-groups/${encodeURIComponent(id)}`),
    update: (id, input) => client.patch(`/v1/chat-groups/${encodeURIComponent(id)}`, input),
    participation: id => client.get(`/v1/loop-items/${encodeURIComponent(id)}/participation`),
    setParticipation: (id, input) =>
      client.put(`/v1/loop-items/${encodeURIComponent(id)}/participation`, input),
  }
}

export function createLocalChatGroupApi(
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
): ChatGroupApi {
  return {
    inviteParticipants: (thread_id, user_ids) =>
      request('chat_groups.participants.invite', { thread_id, user_ids }),
    projectLink: thread_id => request('chat_groups.project_link.get', { thread_id }),
    setProjectLink: (thread_id, version, project_id) =>
      request('chat_groups.project_link.update', { thread_id, version, project_id }),
    addMember: (group_id, user_id, role) =>
      request('chat_groups.members.add', { group_id, user_id, role }),
    removeMember: (group_id, user_id) =>
      request('chat_groups.members.remove', { group_id, user_id }),
    navigation: () => request('chat_groups.navigation'),
    list: () => request('chat_groups.list'),
    create: input => request('chat_groups.create', { ...input }),
    get: group_id => request('chat_groups.get', { group_id }),
    update: (group_id, input) => request('chat_groups.update', { group_id, ...input }),
    participation: thread_id => request('chat_groups.participation.get', { thread_id }),
    setParticipation: (thread_id, input) =>
      request('chat_groups.participation.update', { thread_id, ...input }),
  }
}
