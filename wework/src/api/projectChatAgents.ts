import type { HttpClient } from './http'

export interface ProjectChatAgent {
  id: string
  projectId: string
  name: string
  runtime: 'codex'
  model: string | null
  systemPrompt: string
  status: 'active' | 'archived'
  version: number
  createdAt: string
  updatedAt: string
}

export function createProjectChatAgentApi(client: HttpClient) {
  return {
    list(projectId: string) {
      return client.get<ProjectChatAgent[]>(`/v1/cloud-projects/${projectId}/chat-agents`)
    },
    create(
      projectId: string,
      input: Pick<ProjectChatAgent, 'name' | 'runtime' | 'model' | 'systemPrompt'>
    ) {
      return client.post<ProjectChatAgent>(`/v1/cloud-projects/${projectId}/chat-agents`, input)
    },
    update(
      projectId: string,
      agentId: string,
      input: Partial<Pick<ProjectChatAgent, 'name' | 'model' | 'systemPrompt' | 'status'>> &
        Pick<ProjectChatAgent, 'version'>
    ) {
      return client.patch<ProjectChatAgent>(
        `/v1/cloud-projects/${projectId}/chat-agents/${agentId}`,
        input
      )
    },
  }
}
