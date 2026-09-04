import type { AccessTargetsExtension } from '@/extensions/access-targets-contract'

interface GroupSearchItem {
  id: number
  name: string
  display_name?: string | null
}

export const accessTargetsExtension: AccessTargetsExtension = {
  async searchDepartments(client, query) {
    const response = await client.get<{ items: GroupSearchItem[] }>(
      `/groups/search?q=${encodeURIComponent(query)}&limit=20&include_organization=true`
    )
    return response.items.map(group => ({
      entityType: 'namespace',
      entityId: String(group.id),
      displayName: group.display_name || group.name,
    }))
  },
}
