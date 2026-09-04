import type { HttpClient } from '@/api/http'

export type DepartmentAccessEntityType = 'namespace' | 'org_department'

export interface DepartmentAccessTarget {
  entityType: DepartmentAccessEntityType
  entityId: string
  displayName: string
}

export interface AccessTargetsExtension {
  searchDepartments: (client: HttpClient, query: string) => Promise<DepartmentAccessTarget[]>
}
