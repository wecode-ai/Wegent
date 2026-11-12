import type { CollaborationGroup, SharedWorkspaceApi } from '@wegent/collaboration'

type CreateInput = Parameters<
  NonNullable<SharedWorkspaceApi['projects']['createCollaborationGroup']>
>[1]
type UpdateInput = Parameters<
  NonNullable<SharedWorkspaceApi['projects']['updateCollaborationGroup']>
>[2]

function assertValidCollaborationGroup(
  leader: CollaborationGroup['leader'],
  members: CollaborationGroup['members'],
  stages: CollaborationGroup['stages']
) {
  const identity = (member: CollaborationGroup['leader']) => `${member.kind}:${member.id}`
  const leaderIdentity = identity(leader)
  const memberIdentities = members.map(identity)
  const uniqueMemberIdentities = new Set(memberIdentities)
  if (uniqueMemberIdentities.size !== memberIdentities.length) {
    throw new Error('Collaboration group members must be unique')
  }
  if (!uniqueMemberIdentities.has(leaderIdentity)) {
    throw new Error('Leader must be a member of the collaboration group')
  }
  stages.forEach(stage => {
    if (!stage.assignee) return
    const assigneeIdentity = identity(stage.assignee)
    if (!uniqueMemberIdentities.has(assigneeIdentity)) {
      throw new Error('Collaboration group stage assignee must be a group member')
    }
    if (assigneeIdentity === leaderIdentity) {
      throw new Error('Collaboration group leader cannot execute a stage')
    }
  })
}

export function createLocalCrewRecord(
  input: CreateInput,
  owner: {
    type: CollaborationGroup['owner_type']
    id: string
    workspaceId: string | null
    userId: number
  }
): CollaborationGroup {
  const now = new Date().toISOString()
  const group: CollaborationGroup = {
    id: `local-group-${crypto.randomUUID()}`,
    workspace_id: owner.workspaceId,
    owner_type: owner.type,
    owner_id: owner.id,
    name: input.name,
    description: input.description ?? '',
    instructions: input.instructions ?? '',
    leader: {
      ...input.leader,
      responsibility: input.leader.responsibility ?? '',
    },
    members: input.members.map(member => ({
      ...member,
      responsibility: member.responsibility ?? '',
    })),
    coordination_mode: 'manager',
    stages: (input.stages ?? []).map(stage => ({
      id: stage.id,
      name: stage.name,
      description: stage.description ?? '',
      assignee: stage.assignee
        ? {
            ...stage.assignee,
            responsibility: stage.assignee.responsibility ?? '',
          }
        : null,
    })),
    execution_requirements: {
      required_tags: input.executionRequirements?.requiredTags ?? [],
    },
    version: 1,
    created_by_user_id: owner.userId,
    created_at: now,
    updated_at: now,
  }
  assertValidCollaborationGroup(group.leader, group.members, group.stages)
  return group
}

export function updateLocalCrewRecord(
  current: CollaborationGroup,
  input: UpdateInput
): CollaborationGroup {
  if (current.version !== input.version)
    throw new Error('Collaboration group changed; reload and try again')
  const updated: CollaborationGroup = {
    ...current,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.leader === undefined
      ? {}
      : {
          leader: {
            ...input.leader,
            responsibility: input.leader.responsibility ?? '',
          },
        }),
    ...(input.members === undefined
      ? {}
      : {
          members: input.members.map(member => ({
            ...member,
            responsibility: member.responsibility ?? '',
          })),
        }),
    ...(input.stages === undefined
      ? {}
      : {
          stages: input.stages.map(stage => ({
            id: stage.id,
            name: stage.name,
            description: stage.description ?? '',
            assignee: stage.assignee
              ? {
                  ...stage.assignee,
                  responsibility: stage.assignee.responsibility ?? '',
                }
              : null,
          })),
        }),
    ...(input.executionRequirements === undefined
      ? {}
      : {
          execution_requirements: {
            required_tags: input.executionRequirements.requiredTags,
          },
        }),
    version: current.version + 1,
    updated_at: new Date().toISOString(),
  }
  assertValidCollaborationGroup(updated.leader, updated.members, updated.stages)
  return updated
}
