import { runnerModelIdentity, type ProjectAgentConfigurationHost } from '@wegent/collaboration'

import type { createAgentResourceApi } from '@/api/agentResources'
import type { createLocalProjectChatAgentApi } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectChatAgentEditor } from '@/features/todo/ProjectChatAgentEditor'
import { WeworkAgentPickerDialog } from './WeworkAgentPickerDialog'
import { WeworkAgentResourceForm } from './WeworkAgentResourceForm'

export const weworkProjectAgentConfigurationHost: ProjectAgentConfigurationHost = {
  renderDialog: props => <WeworkAgentPickerDialog {...props} />,
}

/**
 * Wework manages Agents through the resource library. Project additions open
 * the resource form directly, while existing project Agents remain editable.
 */
export function createWeworkProjectAgentConfigurationHost(
  agentResourceApi: ReturnType<typeof createAgentResourceApi> | undefined,
  localAgentApi?: ReturnType<typeof createLocalProjectChatAgentApi>,
  localModelApi?: WorkbenchServices['modelApi'],
  pluginApi?: WorkbenchServices['pluginApi'],
  deviceApi?: Pick<WorkbenchServices['deviceApi'], 'listDevices' | 'listSkills'>
): ProjectAgentConfigurationHost {
  return {
    ...weworkProjectAgentConfigurationHost,
    ...(localAgentApi
      ? {
          async resolveTemplateAgentRouting(runtime, location, projectId) {
            const environments = await localAgentApi.listRunnerEnvironments(
              location === 'local' ? projectId : undefined
            )
            if (environments.length !== 1) throw new Error('template_model_default_unavailable')
            const current = environments[0]
            const defaults = current.models.filter(
              model => model.runtime === runtime && model.is_default
            )
            if (defaults.length !== 1) throw new Error('template_model_default_unavailable')
            let environmentId = current.id
            if (location === 'cloud') {
              if (!agentResourceApi) throw new Error('template_environment_unavailable')
              const currentDeviceKeys = [current.device_key, current.app_device_id].filter(
                (key): key is string => Boolean(key)
              )
              const authorized = (await agentResourceApi.listEnvironments(projectId)).filter(
                environment =>
                  environment.status === 'online' &&
                  currentDeviceKeys.some(
                    key => environment.device_key === key || environment.app_device_id === key
                  ) &&
                  (!projectId || environment.project_authorized)
              )
              if (authorized.length !== 1) throw new Error('template_environment_unavailable')
              environmentId = authorized[0].id
            }
            return {
              executionPolicy: { mode: 'fixed', environment_id: environmentId },
              modelPolicy: { mode: 'fixed', model: runnerModelIdentity(defaults[0]) },
            }
          },
        }
      : {}),
    ...(agentResourceApi
      ? {
          supportsExistingAgentSelection: true,
          async createTemplateAgent(agent, namespace, routing) {
            const created = await agentResourceApi.createAgent({
              ...routing,
              name: `template-${crypto.randomUUID()}`,
              displayName: agent.name,
              namespace,
              runtime: agent.runtime === 'codex' ? 'Codex' : 'ClaudeCode',
              systemPrompt: agent.systemPrompt,
              capabilityMode: 'follow_device',
              model: { name: '' },
              skills: [],
              plugins: [],
              mcpServers: {},
            })
            return { id: String(created.id), name: agent.name }
          },
          async readTemplateAgent(teamId) {
            const agent = await agentResourceApi.getAgent(teamId)
            if (agent.botCount && agent.botCount > 1)
              throw new Error(
                'Multi-Bot Agents cannot be represented by a native template definition'
              )
            if (!agent.runtime) throw new Error('template_agent_runtime_unsupported')
            return {
              name: agent.displayName || agent.name,
              runtime: agent.runtime === 'Codex' ? 'codex' : 'claude_code',
              systemPrompt: agent.systemPrompt,
              capabilityDescription: '',
            }
          },
          renderAgentCreator({
            projectId,
            namespace,
            onClose,
            onCreated,
            ownerOptions,
            workspaceName,
          }) {
            return (
              <WeworkAgentResourceForm
                api={agentResourceApi}
                projectId={projectId}
                deviceApi={deviceApi}
                namespace={namespace}
                onClose={onClose}
                onSaved={onCreated}
                ownerOptions={ownerOptions}
                pluginApi={pluginApi}
                workspaceName={workspaceName}
              />
            )
          },
          renderAgentEditor({ projectId, agent, namespace, onClose, onSaved, workspaceName }) {
            return (
              <WeworkAgentResourceForm
                api={agentResourceApi}
                deviceApi={deviceApi}
                projectId={projectId}
                editingTeamId={agent.teamId}
                key={agent.teamId}
                namespace={namespace}
                onClose={onClose}
                onSaved={onSaved}
                pluginApi={pluginApi}
                workspaceName={workspaceName}
              />
            )
          },
        }
      : {}),
    ...(localAgentApi && localModelApi
      ? {
          renderLocalAgentCreator({ onClose, onCreated, projectId }) {
            return (
              <ProjectChatAgentEditor
                api={localAgentApi}
                deviceApi={deviceApi}
                modelApi={localModelApi}
                pluginApi={pluginApi}
                projectId={projectId}
                skillApi={agentResourceApi}
                onClose={onClose}
                onSaved={onCreated}
              />
            )
          },
          renderLocalAgentEditor({ projectId, resourceId, onClose, onSaved }) {
            return (
              <ProjectChatAgentEditor
                api={localAgentApi}
                deviceApi={deviceApi}
                editingAgentId={resourceId}
                key={resourceId}
                modelApi={localModelApi}
                pluginApi={pluginApi}
                projectId={projectId}
                skillApi={agentResourceApi}
                onClose={onClose}
                onSaved={onSaved}
              />
            )
          },
        }
      : {}),
  }
}
