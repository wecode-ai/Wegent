import {
  collaborationMessages,
  threadStatuses,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'

export function groupBoardContext(
  group: ChatGroup,
  store: 'local' | 'cloud'
): CollaborationProject {
  return {
    id: group.id,
    resource_type: 'chat_group',
    public_id: group.id,
    project_key: group.project_key,
    name: group.name,
    description: group.description,
    project_store: store === 'local' ? 'local' : 'backend',
    task_provider: 'local',
    provider_config: {},
    created_by_user_id: group.created_by_user_id,
    access_role: group.role,
    status: group.status,
    tags: group.configuration?.tags ?? [],
    board_config: {
      ...group.configuration?.board_config,
      group_by: group.configuration?.board_config?.group_by ?? 'status',
      statuses: threadStatuses(collaborationMessages['zh-CN']),
      processing_start_status_id: 'pending',
    },
    board_views: group.configuration?.board_views ?? undefined,
    card_display: group.configuration?.card_display ?? undefined,
    version: group.version,
    created_at: group.created_at,
    updated_at: group.updated_at,
  }
}

/** A scoped board port; group identities never enter the actual project catalog. */
export function createGroupWorkspaceApi(
  base: SharedWorkspaceApi,
  groups: ChatGroupApi,
  groupId: string,
  store: 'local' | 'cloud',
  onMutation: () => void = () => undefined
): SharedWorkspaceApi {
  const get = async () => groupBoardContext((await groups.get(groupId)).group, store)
  const mutate = async <T>(operation: () => Promise<T>) => {
    const value = await operation()
    onMutation()
    return value
  }
  const memberView = (member: import('@/api/chatGroups').ChatGroupMember) => ({
    id: member.user_id,
    user_id: member.user_id,
    user_name: member.name,
    email: null,
    role: member.role,
    direct_role: member.role === 'Owner' ? undefined : member.role,
    can_be_assignee: member.role !== 'Viewer',
  })
  return {
    ...base,
    workspaces: undefined,
    automations: undefined,
    incomingHooks: undefined,
    milestones: undefined,
    issues: {
      ...base.issues,
      create: (...args) => mutate(() => base.issues.create(...args)),
      update: (...args) => mutate(() => base.issues.update(...args)),
      assign: (...args) => mutate(() => base.issues.assign(...args)),
      archive: (...args) => mutate(() => base.issues.archive(...args)),
      restore: (...args) => mutate(() => base.issues.restore(...args)),
      reorder: (...args) => mutate(() => base.issues.reorder(...args)),
    },
    projects: {
      ...base.projects,
      list: async () => [await get()],
      get,
      async update(_id, input) {
        const { group } = await groups.get(groupId)
        const configuration = {
          ...(input.boardConfig ? { board_config: input.boardConfig } : {}),
          ...(input.boardViews ? { board_views: input.boardViews } : {}),
          ...(input.cardDisplay ? { card_display: input.cardDisplay } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
        }
        const updated = await groups.update(groupId, {
          name: input.name ?? group.name,
          description: input.description ?? group.description,
          status: group.status,
          version: input.version,
          configuration,
        })
        return groupBoardContext(updated.group, store)
      },
      async archive(_id, version) {
        const { group } = await groups.get(groupId)
        await groups.update(groupId, {
          name: group.name,
          description: group.description,
          status: 'archived',
          version,
        })
      },
      listExecutionEnvironments: async () => [],
    },
    members: {
      ...base.members,
      async list() {
        return (await groups.get(groupId)).members.map(memberView)
      },
      async add(_id, userId, role = 'Developer') {
        const result = await groups.addMember(groupId, userId, role)
        const member = result.items.find(member => member.user_id === userId)
        if (!member) throw new Error('Group member was not returned after invitation')
        onMutation()
        return memberView(member)
      },
      async update(_id, userId, input) {
        if (!input.role) throw new Error('A group member role is required')
        const result = await groups.addMember(groupId, userId, input.role)
        const member = result.items.find(member => member.user_id === userId)
        if (!member) throw new Error('Group member was not returned after update')
        onMutation()
        return memberView(member)
      },
      async remove(_id, userId) {
        await groups.removeMember(groupId, userId)
        onMutation()
      },
    },
  }
}
