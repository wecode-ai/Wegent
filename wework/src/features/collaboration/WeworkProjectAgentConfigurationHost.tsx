import {
  cloudRunnerModels,
  runnerSupportsModel,
  type ProjectAgentConfigurationHost,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

import type { createAgentResourceApi } from '@/api/agentResources'
import type { createLocalProjectChatAgentApi } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { ProjectChatAgentEditor } from '@/features/todo/ProjectChatAgentEditor'
import { PersonalTeamAdoption } from './PersonalTeamAdoption'
import { ExternalProjectAgentForm } from './ExternalProjectAgentForm'
import { WeworkAgentPickerDialog } from './WeworkAgentPickerDialog'
import { WeworkAgentResourceForm } from './WeworkAgentResourceForm'
import { createProjectAgentEditorApi } from './projectAgentEditorApi'

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
  deviceApi?: Pick<WorkbenchServices['deviceApi'], 'listDevices' | 'listSkills'>,
  projectDefinition?: {
    agents: SharedWorkspaceApi['agents']
    modelApi: WorkbenchServices['modelApi']
    name: string
  },
  personal?: Pick<
    WorkbenchServices,
    'standInApi' | 'getLocalRuntimeSidebarIdentity' | 'personalAssistantAccountApi'
  > & {
    userId: number
  }
): ProjectAgentConfigurationHost {
  const editor =
    projectDefinition && agentResourceApi
      ? {
          api: createProjectAgentEditorApi(projectDefinition.agents, agentResourceApi),
          modelApi: projectDefinition.modelApi,
          ownerLabel: projectDefinition.name,
        }
      : localAgentApi && localModelApi
        ? { api: localAgentApi, modelApi: localModelApi, ownerLabel: undefined }
        : undefined
  return {
    ...weworkProjectAgentConfigurationHost,
    ...(personal?.standInApi
      ? {
          renderPersonalTeamAdoption: (
            props: Parameters<
              NonNullable<ProjectAgentConfigurationHost['renderPersonalTeamAdoption']>
            >[0]
          ) => (
            <PersonalTeamAdoption
              key={JSON.stringify([personal.userId, props.projectId])}
              {...props}
              userId={personal.userId}
              api={personal.standInApi!}
              accountApi={personal.personalAssistantAccountApi}
              agentApi={agentResourceApi}
              identity={personal.getLocalRuntimeSidebarIdentity}
            />
          ),
        }
      : {}),
    ...(localAgentApi
      ? {
          async listTemplateAgentEnvironments(projectId, location) {
            const environments =
              location === 'cloud'
                ? await agentResourceApi!.listEnvironments(projectId)
                : await localAgentApi.listEnvironments(projectId)
            return environments
              .filter(item => location !== 'cloud' || item.project_authorized)
              .map(item => ({
                id: item.id,
                device_key: item.device_key,
                name: item.name,
                kind: 'local_device' as const,
                coding_tools: item.runtimes ?? [],
                owner_type: item.owner_type,
                owner_id: item.owner_id,
                owner_name: '',
                status: item.status === 'unknown' ? ('offline' as const) : item.status,
                updated_at: '',
                can_use: location !== 'cloud' || item.project_authorized,
              }))
          },
          async listTemplateAgentModels(runtime, context) {
            if (context?.environmentId) {
              const source = context.location === 'cloud' ? agentResourceApi! : localAgentApi
              const environments = await source.listEnvironments(context.projectId)
              const selected = environments.find(item => item.id === context.environmentId)
              if (!selected || (context.location === 'cloud' && !selected.project_authorized))
                throw new Error('RUNNER_ENVIRONMENT_UNAVAILABLE')
              const catalog = await source.listNativeModels(selected, context.projectId)
              if (catalog.catalog_error) throw new Error(catalog.catalog_error)
              return { models: catalog.models.filter(model => model.runtime === runtime) }
            }
            const environments = await localAgentApi.listRunnerEnvironments()
            const current = environments.length === 1 ? environments[0] : undefined
            if (!current) throw new Error('template_environment_unavailable')
            return { models: current.models.filter(model => model.runtime === runtime) }
          },
          async listTemplateCloudAgentModels(runtime) {
            const [environments, models] = await Promise.all([
              localAgentApi.listRunnerEnvironments(),
              localAgentApi.listModels(),
            ])
            const current = environments.length === 1 ? environments[0] : undefined
            if (!current) throw new Error('template_environment_unavailable')
            return cloudRunnerModels(models).filter(
              model => model.runtime === runtime && runnerSupportsModel(current, model)
            )
          },
        }
      : {}),
    ...(agentResourceApi
      ? {
          supportsExistingAgentSelection: true,
          renderExternalAgentCreator({ projectId, onBack, onCreated }) {
            return (
              <ExternalProjectAgentForm
                create={input => agentResourceApi.createExternalAgent(projectId, input)}
                checkConnection={agentId =>
                  agentResourceApi.checkExternalAgentConnection(projectId, agentId)
                }
                onBack={onBack}
                onCreated={onCreated}
              />
            )
          },
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
        }
      : {}),
    ...(editor
      ? {
          renderProjectAgentEditor({ projectId, resourceId, onClose, onSaved }) {
            return (
              <ProjectChatAgentEditor
                api={editor.api}
                deviceApi={deviceApi}
                editingAgentId={resourceId}
                key={resourceId}
                modelApi={editor.modelApi}
                ownerLabel={editor.ownerLabel}
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
