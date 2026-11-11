import type { SharedWorkspaceApi, WorkspaceProjectAgent } from '@wegent/collaboration'

import { projectChatAgentFromRecord } from '@/api/local/localDelivery'
import type { RunnerCatalogApi } from './useAgentRouting'
import type { ProjectChatAgentEditorApi } from '@/features/todo/ProjectChatAgentEditor'

function editorAgent(agent: WorkspaceProjectAgent) {
  // The shared API accepts both wire and renderer field names. Normalize only
  // the definition's top-level fields; policies and MCP keys remain untouched.
  const record = Object.fromEntries(
    Object.entries(agent).map(([key, value]) => [
      key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
      value,
    ])
  )
  return projectChatAgentFromRecord({ ...record, id: String(agent.id) })
}

function definitionInput(input: Record<string, unknown>): Record<string, unknown> {
  const definition = { ...input }
  for (const field of ['displayName', 'namespace', 'allowedModels', 'modelNamespace']) {
    delete definition[field]
  }
  // Cloud project definitions use name as their visible label and do not own
  // the local resource namespace or the current-device model allowlist.
  return { ...definition, name: input.displayName || definition.name }
}

export function createProjectAgentEditorApi(
  agents: SharedWorkspaceApi['agents'],
  catalog: RunnerCatalogApi
): ProjectChatAgentEditorApi {
  return {
    listEnvironments: projectId => catalog.listEnvironments(projectId),
    listNativeModels: (environment, projectId) => catalog.listNativeModels(environment, projectId),
    listModels: () => catalog.listModels(),
    async list(projectId, options) {
      return (await agents.list(projectId, options)).map(editorAgent)
    },
    async create(projectId, input) {
      return editorAgent(await agents.create(projectId, definitionInput({ ...input })))
    },
    async update(projectId, agentId, input) {
      const definition = definitionInput(input)
      // These bindings have no controls in the definition form. Leave their
      // stored values intact instead of applying local creation defaults.
      for (const field of ['executionEnvironment', 'executionMode', 'executionDeviceId']) {
        delete definition[field]
      }
      return editorAgent(await agents.update(projectId, agentId, definition))
    },
  }
}
