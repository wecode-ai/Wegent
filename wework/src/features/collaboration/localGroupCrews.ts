import type { SharedWorkspaceApi, CollaborationGroup } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { createLocalCrewRecord, updateLocalCrewRecord } from './localCrewRecords'

/** Local group crews are configuration of their actual group, never a project copy. */
export function localGroupCrews(groups: ChatGroupApi, groupId: string, onMutation: () => void) {
  const requireOwner = (id: string) => {
    if (id !== groupId) throw new Error('Collaboration group belongs to another container')
  }
  const read = async () => (await groups.get(groupId)).group
  const save = async (group: ChatGroup, crews: CollaborationGroup[]) => {
    await groups.update(groupId, {
      name: group.name,
      description: group.description,
      status: group.status,
      version: group.version,
      configuration: { collaboration_groups: crews },
    })
    onMutation()
  }
  return {
    async listCollaborationGroups(id: string) {
      requireOwner(id)
      return (await read()).configuration?.collaboration_groups ?? []
    },
    async createCollaborationGroup(
      ownerId: string,
      input: Parameters<NonNullable<SharedWorkspaceApi['projects']['createCollaborationGroup']>>[1]
    ) {
      requireOwner(ownerId)
      const group = await read()
      const crew = createLocalCrewRecord(input, {
        type: 'chat_group',
        id: groupId,
        workspaceId: null,
        userId: 0,
      })
      crew.binding_owner_id = groupId
      await save(group, [...(group.configuration?.collaboration_groups ?? []), crew])
      return crew
    },
    async updateCollaborationGroup(
      ownerId: string,
      id: string,
      input: Parameters<NonNullable<SharedWorkspaceApi['projects']['updateCollaborationGroup']>>[2]
    ) {
      requireOwner(ownerId)
      const group = await read()
      const crews = group.configuration?.collaboration_groups ?? []
      const current = crews.find(crew => crew.id === id)
      if (!current) throw new Error('Collaboration group was not found')
      const updated = updateLocalCrewRecord(current, input)
      await save(
        group,
        crews.map(crew => (crew.id === id ? updated : crew))
      )
      return updated
    },
    async removeCollaborationGroup(ownerId: string, id: string) {
      requireOwner(ownerId)
      const group = await read()
      const crews = group.configuration?.collaboration_groups ?? []
      if (!crews.some(crew => crew.id === id)) throw new Error('Collaboration group was not found')
      await save(
        group,
        crews.filter(crew => crew.id !== id)
      )
    },
    addCollaborationGroup: undefined,
  }
}
