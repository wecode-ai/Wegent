// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { templateMessages } from '../templates/messages'
import { templateRoutingResolver, materializeTemplateAgents } from '../templates/agents'
import type { CollaborationTemplate } from '../templates/types'
import { prepareTemplateProject, configureTemplateProject } from '../templates/projectConfiguration'
import { ensureWorkspaceEnvironmentSharing } from '../execution-environment/ensureWorkspaceEnvironmentSharing'
import { type PlatformMessages } from './platformMessages'
import { type CollaborationLocale } from '../i18n'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import { createResourceAgentBindingInput } from '../project-agent-config'
import {
  normalizeCollaborationGroupDraftForPersistence,
  ProjectCreateDialog,
  projectCreateLabels,
} from '../project-create'
import type {
  CollaborationGroup,
  CollaborationWorkspaceMember,
  CollaborationOwnedAgent,
  CollaborationWorkspace,
} from '../types'
import type { CollaborationDomain, CollaborationPlatformHostAdapter } from './types'
import { isCurrentDeviceCollaborationAgent } from './useGroupConfiguration'
import type { createPlatformCreationState } from './platformCreationState'
import type { useCollaborationPlatformController } from './useCollaborationPlatformController'

interface ProjectDialogInput {
  api: SharedWorkspaceApi
  creation: ReturnType<typeof createPlatformCreationState>
  commands: ReturnType<typeof useCollaborationPlatformController>['commands']
  state: ReturnType<typeof useCollaborationPlatformController>['state']
  host: CollaborationPlatformHostAdapter
  locale: CollaborationLocale
  messages: PlatformMessages
  projectDialogOpen: boolean
  projectTemplate: CollaborationTemplate | null
  projectCreateLocation: CollaborationDomain
  projectWorkspaceId: string | null
  defaultProjectWorkspace: CollaborationWorkspace | undefined
  projectWorkspace: CollaborationWorkspace | null
  projectWorkspaceOwnerLabel: string | null
  projectWorkspaceMembers: CollaborationWorkspaceMember[]
  selectedProjectResourceAgents: CollaborationOwnedAgent[]
  defaultProjectAgentResourceIds: string[]
  projectWorkspaceGroups: CollaborationGroup[]
  projectCreationResources: import('../types').CollaborationPlatformResources
  projectEnvironmentLoading: boolean
  projectEnvironmentError: boolean
}
export function renderPlatformProjectCreateDialog({
  api,
  creation,
  commands,
  state,
  host,
  locale,
  messages,
  projectDialogOpen,
  projectTemplate,
  projectCreateLocation,
  projectWorkspaceId,
  defaultProjectWorkspace,
  projectWorkspace,
  projectWorkspaceOwnerLabel,
  projectWorkspaceMembers,
  selectedProjectResourceAgents,
  defaultProjectAgentResourceIds,
  projectWorkspaceGroups,
  projectCreationResources,
  projectEnvironmentLoading,
  projectEnvironmentError,
}: ProjectDialogInput) {
  return (
    <>
      {' '}
      {projectDialogOpen ? (
        <ProjectCreateDialog
          initialTemplate={projectTemplate}
          targets={[
            {
              location: projectCreateLocation,
              create: input => commands.createProject(input, projectWorkspaceId),
            },
          ]}
          defaultLocation={projectCreateLocation}
          allowDingTalkAITable={host.capabilities.dingtalkAitable}
          labels={projectCreateLabels[locale]}
          workspaceSelection={
            projectCreateLocation === 'cloud'
              ? {
                  label: messages.chooseProjectWorkspace,
                  value: projectWorkspaceId ?? defaultProjectWorkspace?.id ?? '',
                  options: [
                    ...(!defaultProjectWorkspace
                      ? [{ value: '', label: messages.defaultProjectWorkspace }]
                      : []),
                    ...state.workspaces
                      .filter(
                        workspace =>
                          workspace.location === 'cloud' &&
                          (workspace.access_role === 'Owner' ||
                            workspace.access_role === 'Maintainer' ||
                            workspace.access_role === 'Developer')
                      )
                      .map(workspace => ({
                        value: workspace.id,
                        label:
                          workspace.id === defaultProjectWorkspace?.id
                            ? messages.defaultProjectWorkspace
                            : workspace.name,
                      })),
                  ],
                  onChange: workspaceId => {
                    creation.selectProjectWorkspace(workspaceId)
                  },
                }
              : undefined
          }
          workspaceContext={
            projectWorkspace && projectWorkspaceOwnerLabel
              ? {
                  name: projectWorkspace.name,
                  owner: `${messages.owner}${
                    locale === 'zh-CN' ? '：' : ': '
                  }${projectWorkspaceOwnerLabel}`,
                }
              : undefined
          }
          resourceSetup={{
            location: projectCreateLocation,
            currentUser: host.currentUser ?? {
              id: projectWorkspace?.created_by_user_id ?? 0,
              name: projectCreateLabels[locale].currentUser,
            },
            members: projectWorkspaceMembers,
            searchUsers: projectCreateLocation === 'cloud' ? api.members.searchUsers : undefined,
            agents: selectedProjectResourceAgents,
            defaultAgentResourceIds: defaultProjectAgentResourceIds,
            groups: projectWorkspaceGroups,
            executionEnvironments: projectCreationResources.execution_environments,
            executionEnvironmentLoading: projectEnvironmentLoading,
            executionEnvironmentError: projectEnvironmentError
              ? templateMessages[locale].failed
              : undefined,
            retryExecutionEnvironments: () => creation.refreshResources(),
            loadCollaborationGroupGenerationModels:
              host.loadProjectCollaborationGroupGenerationModels,
            generateCollaborationGroupDraft: host.generateProjectCollaborationGroupDraft,
            configure: async (project, selection) => {
              creation.assertProjectCreationActive()
              if (selection.template) {
                await prepareTemplateProject(api, project.id, selection.template, locale)
              }
              creation.assertProjectCreationActive()
              const existingMembers = await api.members.list(project.id)
              const existingMemberIds = new Set(existingMembers.map(member => member.user_id))
              creation.assertProjectCreationActive()
              const selectedAgents = selectedProjectResourceAgents.filter(agent =>
                selection.agentResourceIds.includes(agent.id)
              )
              const sharedDeviceIds = new Set<number>(
                projectCreateLocation === 'cloud' && selection.executionEnvironmentDeviceIds.length
                  ? (
                      await api.workspaces!.listExecutionEnvironments(project.workspace_id!)
                    ).flatMap(environment =>
                      environment.device_id == null ? [] : [environment.device_id]
                    )
                  : []
              )
              creation.assertProjectCreationActive()
              await Promise.all([
                ...selection.memberUserIds
                  .filter(userId => !existingMemberIds.has(userId))
                  .map(userId => api.members.add(project.id, userId, 'Developer')),
                ...(projectCreateLocation === 'cloud'
                  ? selection.executionEnvironmentDeviceIds
                  : []
                ).map(async deviceId => {
                  await ensureWorkspaceEnvironmentSharing(
                    api,
                    project.workspace_id!,
                    deviceId,
                    sharedDeviceIds
                  )
                  creation.assertProjectCreationActive()
                  return api.projects.addExecutionEnvironment(project.id, deviceId)
                }),
              ])
              creation.assertProjectCreationActive()
              const selectedDefaultAgent = selectedAgents.find(isCurrentDeviceCollaborationAgent)
              const projectDefaultAgent = selectedDefaultAgent
                ? (await api.agents.list(project.id)).find(isCurrentDeviceCollaborationAgent)
                : undefined
              creation.assertProjectCreationActive()
              const createdAgents = [
                ...(selectedDefaultAgent && projectDefaultAgent
                  ? [
                      {
                        resourceId: selectedDefaultAgent.id,
                        projectAgent: projectDefaultAgent,
                      },
                    ]
                  : []),
                ...(await Promise.all(
                  selectedAgents
                    .filter(agent => agent.id !== selectedDefaultAgent?.id || !projectDefaultAgent)
                    .map(async agent => ({
                      resourceId: agent.id,
                      projectAgent: await api.agents.create(
                        project.id,
                        createResourceAgentBindingInput(agent)
                      ),
                    }))
                )),
              ]
              creation.assertProjectCreationActive()
              const resolvedTemplate = selection.template
                ? await materializeTemplateAgents(
                    api,
                    project.id,
                    selection.template,
                    selection.collaborationGroupDrafts,
                    templateMessages[locale].partial,
                    undefined,
                    templateRoutingResolver()
                  )
                : {
                    drafts: selection.collaborationGroupDrafts,
                    agentIds: new Set<string>(),
                  }
              creation.assertProjectCreationActive()
              const templateGroups: CollaborationGroup[] = []
              for (const rawGroupDraft of resolvedTemplate.drafts) {
                creation.assertProjectCreationActive()
                const groupDraft = normalizeCollaborationGroupDraftForPersistence(rawGroupDraft)
                if (!api.projects.createCollaborationGroup) {
                  throw new Error(
                    locale === 'zh-CN'
                      ? '当前项目不支持创建协作小组'
                      : 'This project does not support collaboration groups'
                  )
                }
                const mapParticipant = (participant: typeof groupDraft.leader) => {
                  if (participant.kind === 'human') {
                    return participant
                  }
                  const projectAgent = createdAgents.find(
                    ({ resourceId }) => resourceId === participant.id
                  )?.projectAgent
                  if (resolvedTemplate.agentIds.has(participant.id)) return participant
                  if (!projectAgent) {
                    throw new Error(
                      locale === 'zh-CN'
                        ? '协作小组中的智能体未成功加入项目'
                        : 'An Agent in the group was not added to the project'
                    )
                  }
                  return {
                    ...participant,
                    id: String(projectAgent.id),
                  }
                }
                const leader = mapParticipant(groupDraft.leader)
                if (!leader.id) {
                  throw new Error(
                    locale === 'zh-CN'
                      ? '负责人不在当前协作成员中'
                      : 'The owner is not a current collaborator'
                  )
                }
                const createdGroup = await api.projects.createCollaborationGroup(project.id, {
                  name: groupDraft.name,
                  description: groupDraft.description,
                  instructions: groupDraft.instructions,
                  leader,
                  members: groupDraft.members.map(mapParticipant),
                  coordinationMode: 'manager',
                  stages: groupDraft.stages.map(stage => ({
                    ...stage,
                    assignee: stage.assignee ? mapParticipant(stage.assignee) : null,
                  })),
                  executionRequirements: groupDraft.executionRequirements,
                })
                templateGroups.push(createdGroup)
              }
              creation.assertProjectCreationActive()
              if (selection.template) {
                await configureTemplateProject(
                  api,
                  project.id,
                  selection.template,
                  templateGroups,
                  locale
                )
                return api.projects.get(project.id)
              }
            },
          }}
          testIds={{
            name: 'collaboration-project-name-input',
            description: 'collaboration-project-description-input',
            confirm: 'collaboration-project-create-confirm',
          }}
          onClose={() => {
            creation.closeProject()
          }}
          onCreated={creation.acceptProjectCreated}
        />
      ) : null}
    </>
  )
}
