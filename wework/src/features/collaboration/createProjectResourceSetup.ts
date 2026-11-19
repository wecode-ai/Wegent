import {
  configureProjectMembers,
  ProjectCreateMembersError,
  type ProjectCreateResourceSetup,
} from '@wegent/collaboration/project-create'
import type { CollaborationMember, SharedWorkspaceApi } from '@wegent/collaboration'

// collab.projectCreateMembers.v1: set this build setting to false to roll back.
export function createProjectResourceSetup(
  api: SharedWorkspaceApi | null | undefined,
  currentUser: ProjectCreateResourceSetup['currentUser'],
  onConfigured: (projectId: string, members: CollaborationMember[]) => Promise<void>,
  verificationFailureMessage: string
): ProjectCreateResourceSetup | undefined {
  if (!api || import.meta.env.VITE_COLLAB_PROJECT_CREATE_MEMBERS_V1 === 'false') {
    return undefined
  }
  return {
    location: 'cloud',
    currentUser,
    members: [],
    agents: [],
    groups: [],
    searchUsers: query => api.members.searchUsers(query),
    configure: async (project, selection) => {
      if (!selection.memberUserIds.some(userId => userId !== currentUser.id)) return
      const members = await configureProjectMembers({
        api,
        projectId: project.id,
        currentUserId: currentUser.id,
        memberUserIds: selection.memberUserIds,
        verificationFailureMessage,
      })
      try {
        await onConfigured(
          project.id,
          members.filter(
            member =>
              member.user_id !== currentUser.id && selection.memberUserIds.includes(member.user_id)
          )
        )
      } catch (cause) {
        throw new ProjectCreateMembersError(
          [],
          members,
          cause instanceof Error ? cause.message : String(cause)
        )
      }
    },
  }
}
