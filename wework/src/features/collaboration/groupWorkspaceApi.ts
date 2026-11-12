import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { localGroupAutomations } from './localGroupAutomations'
import { localGroupCrews } from './localGroupCrews'
import { localGroupExecutionDevices } from './localGroupExecutionDevices'
import type { ChatGroupApi } from '@/api/chatGroups'

export { groupWorkContainer as groupBoardContext } from '@/api/groupWorkContainer'
import { groupWorkContainer as groupBoardContext } from '@/api/groupWorkContainer'

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
    automations:
      store === 'local'
        ? localGroupAutomations(groups, groupId, base, onMutation)
        : base.automations,
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
      ...(store === 'local' ? localGroupCrews(groups, groupId, onMutation) : {}),
      ...(store === 'local' ? localGroupExecutionDevices(groups, groupId, base, onMutation) : {}),
      list: async () => [await get()],
      get,
      async update(_id, input) {
        const { group } = await groups.get(groupId)
        const configuration = {
          ...(input.boardConfig ? { board_config: input.boardConfig } : {}),
          ...(input.boardViews ? { board_views: input.boardViews } : {}),
          ...(input.cardDisplay ? { card_display: input.cardDisplay } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(store === 'local'
            ? {
                ...(input.collaborationGroups !== undefined
                  ? { collaboration_groups: input.collaborationGroups }
                  : {}),
                ...(input.automaticProcessingRules !== undefined
                  ? { automatic_processing_rules: input.automaticProcessingRules }
                  : {}),
                ...(input.executionEnvironment !== undefined
                  ? {
                      execution_environment: {
                        repositories: input.executionEnvironment.repositories,
                        workspace_policy:
                          input.executionEnvironment.workspacePolicy ?? 'git_worktree',
                        setup_steps: input.executionEnvironment.setupSteps.map(step => ({
                          command: step.command,
                          working_directory: step.workingDirectory,
                        })),
                      },
                    }
                  : {}),
              }
            : {}),
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
