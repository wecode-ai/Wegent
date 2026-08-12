import type { HttpClient } from './http'

export interface ProjectAgentResourceRef {
  namespace: string
  name: string
  id?: number | null
}

export interface ProjectAgentSecretRef {
  name: string
  purpose: string
}

export interface ProjectChatAgent {
  id: string
  projectId: string
  name: string
  runtime: 'codex'
  harness: 'codex' | 'opencode' | 'claude_code'
  model: string | null
  modelSelection: Record<string, unknown> | null
  systemPrompt: string
  skillRefs: ProjectAgentResourceRef[]
  pluginRefs: ProjectAgentResourceRef[]
  mcpServerRefs: ProjectAgentResourceRef[]
  connectorRefs: ProjectAgentResourceRef[]
  secretRefs: ProjectAgentSecretRef[]
  concurrency: number
  timeoutSeconds: number
  workspacePolicy: Record<string, unknown>
  gitPolicy: Record<string, unknown>
  permissionPolicy: Record<string, unknown>
  approvalPolicy: Record<string, unknown>
  status: 'active' | 'archived'
  visibility: 'private' | 'creator_admin' | 'public'
  executionEnvironment: 'local' | 'cloud'
  executionMode: 'auto' | 'manual_approval'
  executionDeviceId: string | null
  /** The bound local code project (task feature) this robot runs in. */
  localProjectId: number | null
  createdByUserId: number | null
  createdByUserName?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type ProjectChatAgentInput = Pick<ProjectChatAgent, 'name' | 'runtime'> &
  Partial<
    Pick<
      ProjectChatAgent,
      | 'harness'
      | 'model'
      | 'modelSelection'
      | 'systemPrompt'
      | 'skillRefs'
      | 'pluginRefs'
      | 'mcpServerRefs'
      | 'connectorRefs'
      | 'secretRefs'
      | 'concurrency'
      | 'timeoutSeconds'
      | 'workspacePolicy'
      | 'gitPolicy'
      | 'permissionPolicy'
      | 'approvalPolicy'
      | 'visibility'
      | 'executionEnvironment'
      | 'executionMode'
      | 'executionDeviceId'
      | 'localProjectId'
    >
  >

export interface ProjectChatAgentValidation {
  valid: boolean
  issues: string[]
}

export function createProjectChatAgentApi(client: HttpClient) {
  return {
    list(projectId: string) {
      return client.get<ProjectChatAgent[]>(`/v1/cloud-projects/${projectId}/chat-agents`)
    },
    create(projectId: string, input: ProjectChatAgentInput) {
      return client.post<ProjectChatAgent>(`/v1/cloud-projects/${projectId}/chat-agents`, input)
    },
    validate(projectId: string, input: ProjectChatAgentInput) {
      return client.post<ProjectChatAgentValidation>(
        `/v1/cloud-projects/${projectId}/chat-agents/validate`,
        input
      )
    },
    update(
      projectId: string,
      agentId: string,
      input: Partial<
        Pick<
          ProjectChatAgent,
          | 'name'
          | 'harness'
          | 'model'
          | 'modelSelection'
          | 'systemPrompt'
          | 'skillRefs'
          | 'pluginRefs'
          | 'mcpServerRefs'
          | 'connectorRefs'
          | 'secretRefs'
          | 'concurrency'
          | 'timeoutSeconds'
          | 'workspacePolicy'
          | 'gitPolicy'
          | 'permissionPolicy'
          | 'approvalPolicy'
          | 'status'
          | 'visibility'
          | 'executionEnvironment'
          | 'executionMode'
          | 'executionDeviceId'
          | 'localProjectId'
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
