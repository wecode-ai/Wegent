import type { HttpClient } from './http'

export interface ProjectIncomingHook {
  id: string
  projectId: string
  name: string
  status: 'active' | 'disabled'
  webhookUrl: string
  version: number
  createdAt: string
  updatedAt: string
}

export function createProjectIncomingHookApi(client: HttpClient) {
  return {
    list(projectId: string) {
      return client.get<ProjectIncomingHook[]>(`/v1/cloud-projects/${projectId}/incoming-hooks`)
    },
    create(projectId: string, name: string) {
      return client.post<ProjectIncomingHook>(`/v1/cloud-projects/${projectId}/incoming-hooks`, {
        name,
      })
    },
    update(
      projectId: string,
      hookId: string,
      input: { name?: string; status?: ProjectIncomingHook['status']; version: number }
    ) {
      return client.patch<ProjectIncomingHook>(
        `/v1/cloud-projects/${projectId}/incoming-hooks/${hookId}`,
        input
      )
    },
    rotate(projectId: string, hookId: string) {
      return client.post<ProjectIncomingHook>(
        `/v1/cloud-projects/${projectId}/incoming-hooks/${hookId}/rotate`
      )
    },
  }
}
