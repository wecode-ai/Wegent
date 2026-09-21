import {
  mapAutomationExecutionCatalog,
  type CollaborationMember,
  type CollaborationGroup,
  type CollaborationProject,
  type CollaborationWorkspace,
  type SharedWorkspaceApi,
  type WorkspaceAutomationRule,
} from '@wegent/collaboration'
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
    const [items, environments] = await Promise.all([projects(), executionEnvironments()])
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
      agent_count: 0,
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
  const projectAgentApi = detailServices?.projectChatAgentApi
  const listProjectAgents = async (projectId: string) =>
    (await projectAgentApi?.list(projectId))?.map(agent => ({ ...agent })) ?? []
  const projectChatClient = detailServices?.projectChatClient
  const localAgentResources = async () => {
    const agents = await projectAgentApi?.list(DEFAULT_WORK_ITEM_PROJECT_ID)
    const ownerName = locale === 'zh-CN' ? '本地空间' : 'Local space'
    return (agents ?? []).map(agent => ({
      id: agent.id,
      name: agent.name,
      location: 'local' as const,
      capability_description: agent.capabilityDescription,
      system_prompt: agent.systemPrompt,
      runtime: agent.runtime,
      owner_type: 'workspace' as const,
      owner_id: LOCAL_WORKSPACE_ID,
      owner_name: ownerName,
      status: agent.status === 'active' ? ('available' as const) : ('unavailable' as const),
      execution_environment_ids: agent.executionDeviceId
        ? [`device:${agent.executionDeviceId}`]
        : [],
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
      listAgents: async () => [],
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
            ...(await projectAgentApi.create(
              projectId,
              input as Parameters<typeof projectAgentApi.create>[1]
            )),
          }),
          update: async (projectId, agentId, input) => ({
            ...(await projectAgentApi.update(
              projectId,
              agentId,
              input as Parameters<typeof projectAgentApi.update>[2]
            )),
          }),
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
      create: async input => decorateProject(await delivery.projects.create(input)),
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
