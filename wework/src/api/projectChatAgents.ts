import type { HttpClient } from './http'

export interface ProjectChatAgent {
  id: string
  projectId: string
  name: string
  runtime: 'codex' | 'wegent'
  wegentTeamId?: number | null
  model: string | null
  systemPrompt: string
  capabilityDescription?: string
  status: 'active' | 'archived'
  visibility: 'private' | 'creator_admin' | 'public'
  executionEnvironment: 'local' | 'cloud'
  executionMode: 'auto' | 'manual_approval'
  executionDeviceId: string | null
  /** The bound local code project (task feature) this robot runs in. */
  localProjectId: number | null
  maxConcurrentExecutions: number
  createdByUserId: number | null
  createdByUserName?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type ProjectChatAgentInput = Pick<
  ProjectChatAgent,
  | 'name'
  | 'runtime'
  | 'wegentTeamId'
  | 'model'
  | 'systemPrompt'
  | 'capabilityDescription'
  | 'visibility'
  | 'executionEnvironment'
  | 'executionMode'
  | 'executionDeviceId'
  | 'localProjectId'
  | 'maxConcurrentExecutions'
>

export function createProjectChatAgentApi(client: HttpClient) {
  return {
    list(projectId: string) {
      return client.get<ProjectChatAgent[]>(`/v1/cloud-projects/${projectId}/chat-agents`)
    },
    create(projectId: string, input: ProjectChatAgentInput) {
      return client.post<ProjectChatAgent>(`/v1/cloud-projects/${projectId}/chat-agents`, input)
    },
    update(
      projectId: string,
      agentId: string,
      input: Partial<
        Pick<
          ProjectChatAgent,
          | 'name'
          | 'runtime'
          | 'wegentTeamId'
          | 'model'
          | 'systemPrompt'
          | 'capabilityDescription'
          | 'status'
          | 'visibility'
          | 'executionEnvironment'
          | 'executionMode'
          | 'executionDeviceId'
          | 'localProjectId'
          | 'maxConcurrentExecutions'
        >
      > &
        Pick<ProjectChatAgent, 'version'>
    ) {
      return client.patch<ProjectChatAgent>(
        `/v1/cloud-projects/${projectId}/chat-agents/${agentId}`,
        input
      )
    },
  }
}
