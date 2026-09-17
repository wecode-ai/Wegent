import type { HttpClient } from './http'

export type RuntimeWorkspacePolicy = string

export interface RuntimeProfile {
  id: string
  name: string
  executionEnvironment: 'local' | 'cloud'
  executionDeviceId: string
  model: string
  modelType: 'public' | 'user' | 'group' | 'runtime' | null
  modelOptions: Record<string, string>
  workspacePolicy: RuntimeWorkspacePolicy
  status: 'active' | 'archived'
  version: number
  createdAt: string
  updatedAt: string
}

export interface RuntimeProfileInput {
  name: string
  executionEnvironment: 'local' | 'cloud'
  executionDeviceId: string
  model?: string
  modelType?: RuntimeProfile['modelType']
  modelOptions?: Record<string, string>
  workspacePolicy: RuntimeWorkspacePolicy
}

export function runtimeProfileIsRunnable(profile: RuntimeProfile): boolean {
  return (
    profile.status === 'active' &&
    Boolean(profile.executionDeviceId.trim()) &&
    Boolean(profile.model.trim())
  )
}

export function createRuntimeProfileApi(client: HttpClient) {
  return {
    list() {
      return client.get<RuntimeProfile[]>('/v1/runtime-profiles')
    },
    create(input: RuntimeProfileInput) {
      return client.post<RuntimeProfile>('/v1/runtime-profiles', input)
    },
    update(profileId: string, input: Partial<RuntimeProfileInput> & { version: number }) {
      return client.patch<RuntimeProfile>(`/v1/runtime-profiles/${profileId}`, input)
    },
    delete(profileId: string) {
      return client.delete<void>(`/v1/runtime-profiles/${profileId}`)
    },
    getProjectDefault(projectId: string | number) {
      return client.get<{
        projectId: string
        userId: number
        runtimeProfileId: string | null
      }>(`/v1/cloud-projects/${projectId}/runtime-default`)
    },
    setProjectDefault(projectId: string | number, runtimeProfileId: string) {
      return client.put<{
        projectId: string
        userId: number
        runtimeProfileId: string | null
      }>(`/v1/cloud-projects/${projectId}/runtime-default`, { runtimeProfileId })
    },
    selectExecution(
      projectId: string | number,
      executionId: number,
      runtimeProfileId: string,
      version: number
    ) {
      return client.put<Record<string, unknown>>(
        `/v1/cloud-projects/${projectId}/executions/${executionId}/runtime`,
        { runtimeProfileId, version }
      )
    },
  }
}
