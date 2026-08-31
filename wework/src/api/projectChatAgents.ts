import type { HttpClient } from './http'
import type { ModelType, RuntimeProjectPluginRef } from '@/types/api'

export type ProjectChatWorkspaceBinding =
  | {
      type: 'backend_project'
      status: 'ready' | 'needs_rebind'
      projectId: number
      deviceWorkspaceId?: number | null
      deviceId?: string | null
    }
  | {
      type: 'device_project'
      status: 'ready' | 'needs_rebind'
      deviceId: string
      runtimeProjectKey: string
    }
  | {
      type: 'standalone'
      status: 'ready' | 'needs_rebind'
    }
  | {
      type: 'legacy_project'
      status: 'needs_rebind'
      projectId: number
      deviceId?: string | null
    }

export type ProjectChatWorkspaceBindingInput =
  | Omit<Extract<ProjectChatWorkspaceBinding, { type: 'backend_project' }>, 'status'>
  | Omit<Extract<ProjectChatWorkspaceBinding, { type: 'device_project' }>, 'status'>
  | Omit<Extract<ProjectChatWorkspaceBinding, { type: 'standalone' }>, 'status'>

export interface ProjectChatAgent {
  id: string
  projectId: string
  name: string
  runtime: 'codex' | 'wegent'
  wegentTeamId?: number | null
  model: string | null
  modelType: ModelType | null
  modelOptions: Record<string, string>
  systemPrompt: string
  capabilityDescription?: string
  status: 'active' | 'archived'
  visibility: 'private' | 'creator_admin' | 'public'
  executionEnvironment: 'local' | 'cloud'
  executionMode: 'auto' | 'manual_approval'
  executionDeviceId: string | null
  workspaceBinding: ProjectChatWorkspaceBinding
  /** V1 compatibility projection. New writes use workspaceBinding. */
  localProjectId: number | null
  maxConcurrentExecutions: number
  workspacePolicy: 'project' | 'git_worktree'
  defaultRuntimeProfileId: string | null
  plugins: RuntimeProjectPluginRef[]
  createdByUserId: number | null
  createdByUserName?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export function projectChatAgentWorkspaceBinding(
  agent: Pick<ProjectChatAgent, 'workspaceBinding' | 'localProjectId' | 'executionDeviceId'>
): ProjectChatWorkspaceBinding {
  if (agent.workspaceBinding) return agent.workspaceBinding
  if (agent.localProjectId != null) {
    return {
      type: 'legacy_project',
      status: 'needs_rebind',
      projectId: agent.localProjectId,
      deviceId: agent.executionDeviceId,
    }
  }
  return { type: 'standalone', status: 'ready' }
}

export type ProjectChatAgentInput = Pick<
  ProjectChatAgent,
  | 'name'
  | 'runtime'
  | 'wegentTeamId'
  | 'model'
  | 'modelType'
  | 'modelOptions'
  | 'systemPrompt'
  | 'capabilityDescription'
  | 'visibility'
  | 'executionEnvironment'
  | 'executionMode'
  | 'executionDeviceId'
  | 'maxConcurrentExecutions'
  | 'workspacePolicy'
  | 'defaultRuntimeProfileId'
  | 'plugins'
> & { workspaceBinding?: ProjectChatWorkspaceBindingInput | null }

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
          | 'modelType'
          | 'modelOptions'
          | 'systemPrompt'
          | 'capabilityDescription'
          | 'status'
          | 'visibility'
          | 'executionEnvironment'
          | 'executionMode'
          | 'executionDeviceId'
          | 'maxConcurrentExecutions'
          | 'workspacePolicy'
          | 'defaultRuntimeProfileId'
          | 'plugins'
        >
      > & {
        workspaceBinding?: ProjectChatWorkspaceBindingInput | null
      } & Pick<ProjectChatAgent, 'version'>
    ) {
      return client.patch<ProjectChatAgent>(
        `/v1/cloud-projects/${projectId}/chat-agents/${agentId}`,
        input
      )
    },
  }
}
