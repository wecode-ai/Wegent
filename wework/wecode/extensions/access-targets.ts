import type { AccessTargetsExtension } from '@/extensions/access-targets-contract'

interface ErpDepartment {
  id: string
  name?: string | null
  label?: string | null
}

export const accessTargetsExtension: AccessTargetsExtension = {
  async searchDepartments(client, query) {
    const response = await client.get<{ departments: ErpDepartment[] }>(
      `/internal/departments/search?q=${encodeURIComponent(query)}`
    )
    return response.departments.map(department => ({
      entityType: 'org_department',
      entityId: department.id,
      displayName: department.name || department.label || department.id,
    }))
  },
}
