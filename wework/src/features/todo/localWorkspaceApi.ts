import {
  mapAutomationExecutionCatalog,
  type CollaborationMember,
  type CollaborationGroup,
  type CollaborationProject,
  type CollaborationWorkspace,
  type SharedWorkspaceApi,
  type WorkspaceAutomationRule,
} from '@wegent/collaboration'
import { DEFAULT_PROJECT_MANAGER_PROMPT } from '@wegent/collaboration/project-manage'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  isDefaultWorkItemProject,
  type CloudProject,
} from '@/api/deliveries'
import {
  createWeworkAutomationSharedWorkspaceApi,
  createWeworkDeliverySharedWorkspaceApi,
} from '@/features/collaboration'
import type {
  ProjectSpaceApis,
  ProjectSpaceDetailServices,
} from '@/features/workbench/workbenchServices'
import type { LocalProjectChatAgentCreateInput } from '@/api/local/localDelivery'
import {
  ensureDefaultLocalAgent,
  isDefaultLocalAgent,
  isDefaultLocalAgentName,
} from '@/features/collaboration/defaultLocalAgent'
export const LOCAL_WORKSPACE_ID = 'wework-local-workspace'

export function createLocalWorkspaceApi(
  deliveryApi: ProjectSpaceApis['local'] | undefined,
  userId: number,
  userName: string,
  userEmail: string | null,
  detailServices?: ProjectSpaceDetailServices,
  locale: 'zh-CN' | 'en' = 'zh-CN'
): SharedWorkspaceApi | null {
  if (!deliveryApi) return null
  const delivery = createWeworkDeliverySharedWorkspaceApi(deliveryApi)
  const automation = createWeworkAutomationSharedWorkspaceApi(
    deliveryApi,
    detailServices?.projectAutomationApi,
    detailServices?.projectIncomingHookApi
  )
  const decorateProject = (project: CollaborationProject): CollaborationProject => ({
    ...project,
    workspace_id: LOCAL_WORKSPACE_ID,
    current_user_id: userId,
    current_user_name: userName,
  })
  const projects = async () =>
    (await delivery.projects.list())
      .filter(project => !isDefaultWorkItemProject(project as CloudProject))
      .map(decorateProject)
  const executionEnvironments = async () => {
    const devices = await detailServices?.deviceApi.listDevices()
    const now = new Date().toISOString()
    return (devices ?? [])
      .filter(device => device.device_type === 'local' || device.device_type === 'app')
      .map(device => ({
        id: `device:${device.device_id}`,
        device_id: device.id,
        device_key: device.device_id,
        is_current_device: true,
        name: device.name,
        kind: 'local_device' as const,
        coding_tools: ['codex'],
        owner_type: 'workspace' as const,
        owner_id: LOCAL_WORKSPACE_ID,
        owner_name: locale === 'zh-CN' ? '本地空间' : 'Local space',
        status:
          device.status === 'online' || device.status === 'busy'
            ? ('online' as const)
            : ('offline' as const),
        updated_at: now,
      }))
  }
  const workspace = async (): Promise<CollaborationWorkspace> => {
    const [items, environments, agents] = await Promise.all([
      projects(),
      executionEnvironments(),
      localAgentResources(),
    ])
    const now = new Date().toISOString()
    return {
      id: LOCAL_WORKSPACE_ID,
      location: 'local',
      name: locale === 'zh-CN' ? '本地空间' : 'Local space',
      namespace: 'default',
      description:
        locale === 'zh-CN'
          ? '保存在当前设备上的项目、Issue 与执行资源。'
          : 'Projects, issues, and execution resources stored on this device.',
      access_role: 'Owner',
      member_count: 1,
      agent_count: agents.length,
      execution_environment_count: environments.length,
      project_count: items.length,
      created_by_user_id: userId,
      version: 1,
      created_at: now,
      updated_at: now,
    }
  }
  const unavailable = async (): Promise<never> => {
    throw new Error(
      locale === 'zh-CN'
        ? '本地空间不支持此操作'
        : 'This operation is not available in the local space'
    )
  }
  const currentMember = async (): Promise<CollaborationMember[]> => [
    {
      id: userId,
      user_id: userId,
      user_name: userName,
      email: userEmail,
      role: 'Owner',
    },
  ]
  const projectAgentApi = detailServices?.localProjectChatAgentApi
  const listProjectAgents = async (projectId: string) =>
    (await projectAgentApi?.list(projectId))?.map(agent => ({
      ...agent,
      agent_id: agent.name,
      deletable: !isDefaultLocalAgent(agent),
      name: agent.displayName || agent.name,
    })) ?? []
  const projectChatClient = detailServices?.projectChatClient
  const localAgentResources = async () => {
    const listedAgents = projectAgentApi
      ? await projectAgentApi.list(DEFAULT_WORK_ITEM_PROJECT_ID).catch(error => {
          console.warn('[Wework] Failed to list local Agents', error)
          return []
        })
      : []
    const defaultAgent = projectAgentApi
      ? await ensureDefaultLocalAgent(
          projectAgentApi,
          DEFAULT_WORK_ITEM_PROJECT_ID,
          locale,
          listedAgents
        ).catch(error => {
          console.warn('[Wework] Failed to ensure the default local Agent', error)
          return null
        })
      : null
    const agents =
      defaultAgent && !listedAgents.some(agent => agent.id === defaultAgent.id)
        ? [...listedAgents, defaultAgent]
        : listedAgents
    const ownerName = locale === 'zh-CN' ? '本地空间' : 'Local space'
    return agents.map(agent => ({
      id: agent.id,
      agent_id: agent.name,
      name: agent.displayName || agent.name,
      location: 'local' as const,
      version: agent.version,
      capability_description: agent.capabilityDescription,
      system_prompt: agent.systemPrompt,
      runtime: agent.runtime,
      owner_type: 'workspace' as const,
      owner_id: LOCAL_WORKSPACE_ID,
      owner_name: ownerName,
      deletable: !isDefaultLocalAgent(agent),
      status: agent.status === 'active' ? ('available' as const) : ('unavailable' as const),
      execution_environment_ids: agent.executionDeviceId
        ? [`device:${agent.executionDeviceId}`]
        : [],
      project_binding_input: {
        name: agent.name,
        displayName: agent.displayName,
        namespace: agent.namespace,
        runtime: agent.runtime,
        model: agent.model,
        modelType: agent.modelType,
        modelNamespace: agent.modelNamespace,
        capabilityDescription: agent.capabilityDescription,
        capabilityMode: agent.capabilityMode,
        systemPrompt: agent.systemPrompt,
        additionalSkills: agent.additionalSkills,
        mcpServers: agent.mcpServers,
        visibility: agent.visibility,
        executionEnvironment: agent.executionEnvironment,
        executionMode: agent.executionMode,
        executionDeviceId: agent.executionDeviceId,
        localProjectId: agent.localProjectId,
        maxConcurrentExecutions: agent.maxConcurrentExecutions,
        workspacePolicy: agent.workspacePolicy,
        plugins: agent.plugins,
      },
    }))
  }
  const projectCollaborationGroups = async (projectId: string): Promise<CollaborationGroup[]> => {
    const project = await delivery.projects.get(projectId)
    return project.collaboration_groups ?? []
  }
  const persistProjectCollaborationGroups = async (
    projectId: string,
    groups: CollaborationGroup[]
  ) => {
    const project = await delivery.projects.get(projectId)
    await delivery.projects.update(projectId, {
      version: project.version,
      collaborationGroups: groups,
    })
  }
  const issueProjectId = async (issueId: string) =>
    String((await delivery.issues.get(issueId)).cloud_project_id)
  const projectAutomaticProcessingRules = async (
    projectId: string
  ): Promise<WorkspaceAutomationRule[]> => {
    const project = await delivery.projects.get(projectId)
    return project.automatic_processing_rules ?? []
  }
  const persistProjectAutomaticProcessingRules = async (
    projectId: string,
    rules: WorkspaceAutomationRule[]
  ) => {
    const project = await delivery.projects.get(projectId)
    const updated = await delivery.projects.update(projectId, {
      version: project.version,
      automaticProcessingRules: rules,
    })
    return updated.version
  }
  const localAutomations: NonNullable<SharedWorkspaceApi['automations']> = {
    list: projectAutomaticProcessingRules,
    async create(projectId, input) {
      const now = new Date().toISOString()
      const rule: WorkspaceAutomationRule = {
        ...input,
        id: crypto.randomUUID(),
        projectId,
        name: String(input.name ?? ''),
        enabled: input.enabled !== false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      const rules = await projectAutomaticProcessingRules(projectId)
      await persistProjectAutomaticProcessingRules(projectId, [...rules, rule])
      return rule
    },
    migrateWorkflow: unavailable,
    async update(projectId, automationId, input) {
      const rules = await projectAutomaticProcessingRules(projectId)
      const current = rules.find(rule => rule.id === automationId)
      if (!current) {
        throw new Error(
          locale === 'zh-CN' ? '未找到自动处理规则' : 'Automatic processing rule was not found'
        )
      }
      if (current.version !== input.version) {
        throw new Error(
          locale === 'zh-CN'
            ? '自动处理规则已被更新，请刷新后重试'
            : 'The automatic processing rule changed. Refresh and try again.'
        )
      }
      const updated: WorkspaceAutomationRule = {
        ...current,
        ...input,
        id: current.id,
        projectId,
        name: String(input.name ?? current.name),
        enabled: input.enabled === undefined ? current.enabled : input.enabled !== false,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      }
      await persistProjectAutomaticProcessingRules(
        projectId,
        rules.map(rule => (rule.id === automationId ? updated : rule))
      )
      return updated
    },
    async remove(projectId, automationId) {
      const rules = await projectAutomaticProcessingRules(projectId)
      const nextRules = rules.filter(rule => rule.id !== automationId)
      if (nextRules.length === rules.length) {
        throw new Error(
          locale === 'zh-CN' ? '未找到自动处理规则' : 'Automatic processing rule was not found'
        )
      }
      const projectVersion = await persistProjectAutomaticProcessingRules(projectId, nextRules)
      return { projectVersion, workflowAutomationId: null }
    },
    async runNow(projectId, automationId) {
      if (!detailServices?.localProjectAutomationApi) return unavailable()
      const runs = await detailServices.localProjectAutomationApi.run(projectId, automationId)
      if (!runs.length)
        throw new Error(locale === 'zh-CN' ? '没有可处理的 Issue' : 'No open Issues to process')
      return runs[0]
    },
    runWorkflowNode: unavailable,
    listRuns: (projectId, automationId) =>
      detailServices?.localProjectAutomationApi?.listRuns(projectId, automationId) ?? unavailable(),
    cancelRun: (projectId, runId) =>
      detailServices?.localProjectAutomationApi?.cancelRun(projectId, runId) ?? unavailable(),
    retryRun: (projectId, runId) =>
      detailServices?.localProjectAutomationApi?.retryRun(projectId, runId) ?? unavailable(),
  }

  return {
    ...(delivery as unknown as SharedWorkspaceApi),
    automationExecutionCatalog: {
      async load() {
        const [devices, models, runtimeProfiles] = await Promise.all([
          detailServices?.deviceApi.listDevices() ?? [],
          detailServices?.modelApi.listModels() ?? { data: [] },
          detailServices?.runtimeProfileApi?.list() ?? [],
        ])
        return mapAutomationExecutionCatalog({ items: devices }, models, runtimeProfiles)
      },
      loadPlugins: async () => [],
    },
    automations: localAutomations,
    projectManager: {
      async get(projectId) {
        const project = await delivery.projects.get(projectId)
        return project.project_manager
          ? {
              ...project.project_manager,
              projectId,
              version: project.version,
            }
          : {
              projectId,
              version: project.version,
              enabled: false,
              agentId: '',
              prompt: '',
              triggers: [],
            }
      },
      async save(projectId, config) {
        const project = await delivery.projects.update(projectId, {
          version: config.version,
          projectManager: { ...config, projectId },
        })
        return { ...config, projectId, version: project.version }
      },
      async run(projectId, message, modelSelection) {
        if (!detailServices?.localProjectAutomationApi) return unavailable()
        return detailServices.localProjectAutomationApi.runManager(
          projectId,
          message,
          modelSelection
        )
      },
      async listRuns(projectId) {
        if (!detailServices?.localProjectAutomationApi) return unavailable()
        return detailServices.localProjectAutomationApi.listManagerRuns(projectId)
      },
      async getRun(projectId, runId) {
        if (!detailServices?.localProjectAutomationApi) return unavailable()
        const runs = await detailServices.localProjectAutomationApi.listManagerRuns(projectId)
        const run = runs.find(item => item.id === runId)
        if (!run) throw new Error('Project AI run was not found')
        return run
      },
      async decide(projectId, runId, actionId, approve, version) {
        if (!detailServices?.localProjectAutomationApi) return unavailable()
        return detailServices.localProjectAutomationApi.decideManagerAction(
          projectId,
          runId,
          actionId,
          approve,
          version
        )
      },
    },
    ...(automation.incomingHooks
      ? {
          incomingHooks: {
            ...automation.incomingHooks,
            listEvents: unavailable,
          },
        }
      : {}),
    workspaces: {
      list: async () => [await workspace()],
      get: workspace,
      create: unavailable,
      update: unavailable,
      archive: unavailable,
      listMembers: currentMember,
      addMember: unavailable,
      updateMember: unavailable,
      removeMember: unavailable,
      listAgents: localAgentResources,
      addAgent: unavailable,
      removeAgent: unavailable,
      listCollaborationGroups: () => projectCollaborationGroups(DEFAULT_WORK_ITEM_PROJECT_ID),
      createCollaborationGroup: (_workspaceId, input) =>
        createCollaborationGroup(DEFAULT_WORK_ITEM_PROJECT_ID, input),
      updateCollaborationGroup: (_workspaceId, groupId, input) =>
        updateCollaborationGroup(DEFAULT_WORK_ITEM_PROJECT_ID, groupId, input),
      removeCollaborationGroup: (_workspaceId, groupId) =>
        removeCollaborationGroup(DEFAULT_WORK_ITEM_PROJECT_ID, groupId),
      listExecutionEnvironments: executionEnvironments,
      addExecutionEnvironment: unavailable,
      removeExecutionEnvironment: unavailable,
      initializeExecutionEnvironment: unavailable,
    },
    resources: {
      list: async () => ({
        agents: await localAgentResources(),
        execution_environments: await executionEnvironments(),
      }),
      async removeAgent(agent) {
        if (!projectAgentApi || agent.version == null) {
          throw new Error(
            locale === 'zh-CN' ? '无法删除这个本地智能体' : 'This local agent cannot be deleted'
          )
        }
        if (
          agent.deletable === false ||
          isDefaultLocalAgentName(agent.agent_id) ||
          isDefaultLocalAgentName(agent.name)
        ) {
          throw new Error(
            locale === 'zh-CN'
              ? '默认本地智能体不能删除'
              : 'The default local Agent cannot be deleted'
          )
        }
        await projectAgentApi.archive(DEFAULT_WORK_ITEM_PROJECT_ID, agent.id, agent.version)
      },
    },
    comments: projectChatClient
      ? {
          async list(issueId) {
            const { snapshot, unsubscribe } = await projectChatClient.subscribe(
              await issueProjectId(issueId),
              issueId,
              0,
              () => undefined
            )
            unsubscribe()
            return snapshot.messages.map(message => ({
              id: message.messageId,
              body: message.content,
              author: message.sender.name,
              web_url: null,
              created_at: message.createdAt,
              updated_at: message.updatedAt,
            }))
          },
          async create(issueId, body) {
            const message = await projectChatClient.send({
              projectId: await issueProjectId(issueId),
              taskId: issueId,
              clientMessageId: crypto.randomUUID(),
              text: body,
            })
            return {
              id: message.messageId,
              body: message.content,
              author: message.sender.name,
              web_url: null,
              created_at: message.createdAt,
              updated_at: message.updatedAt,
            }
          },
        }
      : {
          list: async () => [],
          create: unavailable,
        },
    agents: projectAgentApi
      ? {
          list: listProjectAgents,
          create: async (projectId, input) => ({
            ...(await projectAgentApi.create(projectId, toLocalAgentCreateInput(input))),
          }),
          update: async (projectId, agentId, input) => {
            if (input.status === 'archived') {
              const existing = (await projectAgentApi.list(projectId)).find(
                agent => agent.id === agentId
              )
              if (existing && isDefaultLocalAgent(existing)) {
                throw new Error(
                  locale === 'zh-CN'
                    ? '默认本地智能体不能停用'
                    : 'The default local Agent cannot be archived'
                )
              }
            }
            return {
              ...(await projectAgentApi.update(
                projectId,
                agentId,
                input as Parameters<typeof projectAgentApi.update>[2]
              )),
            }
          },
        }
      : {
          list: async () => [],
          create: unavailable,
          update: unavailable,
        },
    projects: {
      ...delivery.projects,
      list: projects,
      get: async projectId => decorateProject(await delivery.projects.get(projectId)),
      create: async input => {
        const { includeDefaultAgent = true, ...projectInput } = input
        let project = decorateProject(await delivery.projects.create(projectInput))
        if (projectAgentApi && includeDefaultAgent) {
          const agent = await ensureDefaultLocalAgent(projectAgentApi, project.id, locale).catch(
            error => {
              console.warn(
                `[Wework] Failed to ensure the default local Agent for project ${project.id}`,
                error
              )
              return null
            }
          )
          if (agent) {
            project = decorateProject(
              await delivery.projects.update(project.id, {
                version: project.version,
                projectManager: {
                  projectId: project.id,
                  version: project.version,
                  enabled: true,
                  agentId: agent.id,
                  prompt: DEFAULT_PROJECT_MANAGER_PROMPT,
                  triggers: [],
                },
              })
            )
          }
        }
        return project
      },
      update: async (projectId, input) =>
        decorateProject(await delivery.projects.update(projectId, input)),
      listExecutionEnvironments: executionEnvironments,
      addExecutionEnvironment: unavailable,
      removeExecutionEnvironment: unavailable,
      initializeExecutionEnvironment: unavailable,
      importMessages: unavailable,
      listCollaborationGroups: projectCollaborationGroups,
      createCollaborationGroup,
      updateCollaborationGroup,
      removeCollaborationGroup,
      async addCollaborationGroup(projectId, groupId) {
        const groups = await projectCollaborationGroups(projectId)
        const existing = groups.find(group => group.id === groupId)
        if (existing) return existing
        const source = (await projectCollaborationGroups(DEFAULT_WORK_ITEM_PROJECT_ID)).find(
          group => group.id === groupId
        )
        if (!source) throw new Error('Collaboration group was not found')
        await persistProjectCollaborationGroups(projectId, [...groups, source])
        return source
      },
    },
    issues: {
      ...delivery.issues,
      async getBoardSnapshot(projectId) {
        const [snapshot, agents] = await Promise.all([
          delivery.issues.getBoardSnapshot(projectId),
          listProjectAgents(projectId),
        ])
        return {
          ...snapshot,
          agents,
          members: await currentMember(),
        }
      },
    },
    members: {
      ...delivery.members,
      list: currentMember,
    },
  }

  async function createCollaborationGroup(
    projectId: string,
    input: Parameters<NonNullable<SharedWorkspaceApi['projects']['createCollaborationGroup']>>[1]
  ) {
    const now = new Date().toISOString()
    const groups = await projectCollaborationGroups(projectId)
    const group: CollaborationGroup = {
      id: `local-group-${crypto.randomUUID()}`,
      workspace_id: LOCAL_WORKSPACE_ID,
      owner_type: projectId === DEFAULT_WORK_ITEM_PROJECT_ID ? 'workspace' : 'project',
      owner_id: projectId === DEFAULT_WORK_ITEM_PROJECT_ID ? LOCAL_WORKSPACE_ID : projectId,
      name: input.name,
      description: input.description ?? '',
      instructions: input.instructions ?? '',
      leader: {
        ...input.leader,
        responsibility: input.leader.responsibility ?? '',
      },
      members: input.members.map(member => ({
        ...member,
        responsibility: member.responsibility ?? '',
      })),
      coordination_mode: 'manager',
      stages: (input.stages ?? []).map(stage => ({
        id: stage.id,
        name: stage.name,
        description: stage.description ?? '',
        assignee: stage.assignee
          ? {
              ...stage.assignee,
              responsibility: stage.assignee.responsibility ?? '',
            }
          : null,
      })),
      execution_requirements: {
        required_tags: input.executionRequirements?.requiredTags ?? [],
      },
      version: 1,
      created_by_user_id: userId,
      created_at: now,
      updated_at: now,
    }
    await persistProjectCollaborationGroups(projectId, [...groups, group])
    return group
  }

  async function updateCollaborationGroup(
    projectId: string,
    groupId: string,
    input: Parameters<NonNullable<SharedWorkspaceApi['projects']['updateCollaborationGroup']>>[2]
  ) {
    const groups = await projectCollaborationGroups(projectId)
    const current = groups.find(group => group.id === groupId)
    if (!current) throw new Error('Collaboration group was not found')
    if (current.version !== input.version) {
      throw new Error('Collaboration group changed; reload and try again')
    }
    const updated: CollaborationGroup = {
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.leader === undefined
        ? {}
        : {
            leader: {
              ...input.leader,
              responsibility: input.leader.responsibility ?? '',
            },
          }),
      ...(input.members === undefined
        ? {}
        : {
            members: input.members.map(member => ({
              ...member,
              responsibility: member.responsibility ?? '',
            })),
          }),
      ...(input.stages === undefined
        ? {}
        : {
            stages: input.stages.map(stage => ({
              id: stage.id,
              name: stage.name,
              description: stage.description ?? '',
              assignee: stage.assignee
                ? {
                    ...stage.assignee,
                    responsibility: stage.assignee.responsibility ?? '',
                  }
                : null,
            })),
          }),
      ...(input.executionRequirements === undefined
        ? {}
        : {
            execution_requirements: {
              required_tags: input.executionRequirements.requiredTags,
            },
          }),
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    }
    await persistProjectCollaborationGroups(
      projectId,
      groups.map(group => (group.id === groupId ? updated : group))
    )
    return updated
  }

  async function removeCollaborationGroup(projectId: string, groupId: string) {
    const groups = await projectCollaborationGroups(projectId)
    await persistProjectCollaborationGroups(
      projectId,
      groups.filter(group => group.id !== groupId)
    )
  }
}

function toLocalAgentCreateInput(input: Record<string, unknown>): LocalProjectChatAgentCreateInput {
  if (typeof input.name !== 'string' || !input.name.trim()) {
    throw new Error('Local Agent name is required')
  }
  if (input.runtime !== 'codex' && input.runtime !== 'claude_code') {
    throw new Error('Local Agent runtime is invalid')
  }
  return {
    ...input,
    name: input.name,
    runtime: input.runtime,
  } as LocalProjectChatAgentCreateInput
}
