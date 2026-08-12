import { convertFileSrc } from '@tauri-apps/api/core'

import {
  createProjectTaskTrackingSingleFlight,
  nextTaskTrackingStatus,
  type CloudLoopItemAttachment,
  type CloudLoopItem,
  type CloudProject,
  type CloudProjectFile,
  type CloudProjectId,
  type CloudProjectMember,
  type Delivery,
  type DeliveryAsset,
  type DeliveryCreateInput,
  type DeliveryDetail,
} from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { openLocalFile } from '@/lib/local-terminal'
import type { RuntimeTaskAddress } from '@/types/api'
import type { ProjectAgentResourceRef, ProjectAgentSecretRef } from '@/api/projectChatAgents'
import type {
  ConfigurationValidation,
  ProjectAgentSquad,
  ProjectAgentSquadInput,
  ProjectWorkflowAutomation,
  ProjectWorkflowAutomationInput,
  ProjectWorkflowAutomationRun,
  RepositoryBinding,
  RepositoryBindingInput,
  SquadRoutePreview,
  TaskDevelopment,
  TaskExecutionBinding,
  TaskExecutionBindingInput,
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowRun,
  WorkflowRunDetail,
} from '@/api/projectWorkflows'
import type { Automation, AutomationRun } from '@/types/automation'

type LocalRequest = <T>(
  method: string,
  params?: Record<string, unknown>,
  deviceId?: string
) => Promise<T>

interface LocalLoopItemRecord {
  id: string
  resource_type: 'project' | 'task' | string
  cloud_project_id: string | null
  parent_id: string | null
  public_id: string | null
  project_key: string | null
  name: string | null
  title: string | null
  description: string
  created_by_user_id: number
  sequence_number: number | null
  status: string | null
  priority: string | null
  sort_order: number
  current_delivery_id: string | null
  metadata: Record<string, unknown>
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
  assignee_user_id?: number | null
  execution_id?: number | null
  execution_state?: string | null
}

interface LocalTaskBindingRecord {
  id: string
  cloud_project_id: string
  loop_item_id: string | null
  task_user_id: number
  device_id: string
  task_id: string
  task_title: string | null
  backend_task_id: number | null
  linked_at: string
}

interface LocalProjectFileRecord {
  id: string
  cloud_project_id: string
  path: string
  name: string
  kind: 'file' | 'folder' | string
  content_type: string | null
  size_bytes: number
  sha256: string | null
  description: string
  created_by_user_id: number
  updated_by_user_id: number
  version: number
  created_at: string
  updated_at: string
}

interface LocalAccessRecord {
  path: string
}

export interface LocalProjectChatAgent {
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
  localProjectId: number | null
  createdByUserId: number | null
  createdByUserName?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface LocalLoopItemExecution {
  id: number
  loop_item_id: string
  cloud_project_id: string
  task_title: string
  task_status?: string | null
  task_priority?: string | null
  agent_id: string
  assigner_user_id: number
  execution_environment: string
  execution_device_id?: string | null
  status: string
  priority_weight: number
  queued_at?: string | null
  started_at?: string | null
  completed_at?: string | null
  lease_expires_at?: string | null
  heartbeat_at?: string | null
  retry_attempt: number
  error_message: string
  execution_note: string
  approval_status?: string | null
  approved_by_user_id?: number | null
  rejected_reason?: string | null
  runtime_device_id?: string | null
  runtime_task_id?: string | null
  version: number
  created_at: string
  updated_at: string
  agent_name: string
  agent_system_prompt: string
  agent_model?: string | null
  execution_payload?: Record<string, unknown> | null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function localProject(record: LocalLoopItemRecord): CloudProject {
  const taskProvider =
    record.metadata.task_provider === 'github' ||
    record.metadata.task_provider === 'gitlab' ||
    record.metadata.task_provider === 'dingtalk_aitable'
      ? record.metadata.task_provider
      : 'local'
  return {
    id: record.id,
    public_id: record.public_id ?? record.id,
    project_key: record.project_key ?? 'LOCAL',
    name: record.name ?? '',
    description: record.description,
    project_store: 'local',
    task_provider: taskProvider,
    provider_config:
      record.metadata.provider_config &&
      typeof record.metadata.provider_config === 'object' &&
      !Array.isArray(record.metadata.provider_config)
        ? (record.metadata.provider_config as CloudProject['provider_config'])
        : {},
    board_config:
      record.metadata.board_config &&
      typeof record.metadata.board_config === 'object' &&
      !Array.isArray(record.metadata.board_config)
        ? (record.metadata.board_config as CloudProject['board_config'])
        : undefined,
    card_display:
      record.metadata.card_display &&
      typeof record.metadata.card_display === 'object' &&
      !Array.isArray(record.metadata.card_display)
        ? (record.metadata.card_display as CloudProject['card_display'])
        : undefined,
    created_by_user_id: 0,
    current_user_id: 0,
    current_user_name: '',
    access_role: 'Owner',
    visibility: 'private',
    status: record.status ?? 'active',
    tags: stringList(record.metadata.tags),
    version: record.version,
    created_at: record.created_at,
    updated_at: record.updated_at,
  }
}

function externalProjectDescriptor(project: CloudProject, token?: string) {
  return {
    id: project.id,
    public_id: project.public_id,
    project_key: project.project_key,
    name: project.name,
    description: project.description,
    project_store: project.project_store,
    task_provider: project.task_provider,
    provider_config: {
      ...project.provider_config,
      ...(token?.trim() ? { token: token.trim() } : {}),
    },
    version: project.version,
  }
}

export function createExternalIssueApi(request: LocalRequest) {
  return {
    async configureProject(project: CloudProject, token?: string) {
      await request('external_projects.configure', {
        project: externalProjectDescriptor(project, token),
      })
    },
    async removeProject(projectId: CloudProject['id']) {
      await request('external_projects.remove', { project_id: projectId })
    },
    async retainProjects(projectIds: CloudProject['id'][]) {
      await request('external_projects.retain', { project_ids: projectIds })
    },
    async listLoopItems(project: CloudProject) {
      const records = await request<LocalLoopItemRecord[]>('external_todos.list', {
        project: externalProjectDescriptor(project),
      })
      return { items: records.map(record => localTask(record, project)) }
    },
    async getLoopItem(project: CloudProject, itemId: string) {
      const record = await request<LocalLoopItemRecord>('external_todos.get', {
        project: externalProjectDescriptor(project),
        task_id: itemId,
      })
      return localTask(record, project)
    },
    async createLoopItem(
      project: CloudProject,
      data: {
        title: string
        description?: string
        status?: CloudLoopItem['status']
        priority?: CloudLoopItem['priority']
        parent_id?: string | null
        tags?: string[]
        creator_name?: string
      }
    ) {
      // The creator label keeps the numeric id as the authoritative identity
      // (`wegent:creator:<id>`); a best-effort display name is appended for
      // humans browsing the provider UI (`wegent:creator:<id>:<name>`).
      // Provider label separators (comma for GitLab) cannot appear in names.
      const creatorName = data.creator_name?.replace(/[,:]/g, ' ').trim()
      const creatorLabel =
        (project.current_user_id ?? 0) > 0
          ? [`wegent:creator:${project.current_user_id}${creatorName ? `:${creatorName}` : ''}`]
          : []
      const record = await request<LocalLoopItemRecord>('external_todos.create', {
        project: externalProjectDescriptor(project),
        todo: {
          title: data.title,
          description: data.description ?? '',
          status: data.status ?? 'inbox',
          priority: data.priority ?? 'none',
          parent_id: data.parent_id ?? null,
          tags: [...(data.tags ?? []), ...creatorLabel],
        },
      })
      return localTask(record, project)
    },
    async updateLoopItem(
      project: CloudProject,
      itemId: string,
      data: Record<string, unknown> & { version: number }
    ) {
      const record = await request<LocalLoopItemRecord>('external_todos.update', {
        project: externalProjectDescriptor(project),
        task_id: itemId,
        todo: data,
      })
      return localTask(record, project)
    },
  }
}

type LocalAgentRecord = Record<string, unknown> & {
  id: string
  project_id?: string
  name?: string
  harness?: string
  model?: string | null
  model_selection?: Record<string, unknown> | null
  system_prompt?: string
  skill_refs?: ProjectAgentResourceRef[]
  plugin_refs?: ProjectAgentResourceRef[]
  mcp_server_refs?: ProjectAgentResourceRef[]
  connector_refs?: ProjectAgentResourceRef[]
  secret_refs?: ProjectAgentSecretRef[]
  concurrency?: number
  timeout_seconds?: number
  workspace_policy?: Record<string, unknown>
  git_policy?: Record<string, unknown>
  permission_policy?: Record<string, unknown>
  approval_policy?: Record<string, unknown>
  status?: string
  visibility?: string
  execution_environment?: string
  execution_mode?: string
  execution_device_id?: string | null
  local_project_id?: number | null
  created_by_user_id?: number | null
  version?: number
  created_at?: string
  updated_at?: string
}

function localAgent(record: LocalAgentRecord): LocalProjectChatAgent {
  return {
    id: record.id,
    projectId: record.project_id ?? '',
    name: record.name ?? 'AI',
    runtime: 'codex',
    harness:
      record.harness === 'opencode' || record.harness === 'claude_code' ? record.harness : 'codex',
    model: record.model ?? null,
    modelSelection: record.model_selection ?? null,
    systemPrompt: record.system_prompt ?? '',
    skillRefs: record.skill_refs ?? [],
    pluginRefs: record.plugin_refs ?? [],
    mcpServerRefs: record.mcp_server_refs ?? [],
    connectorRefs: record.connector_refs ?? [],
    secretRefs: record.secret_refs ?? [],
    concurrency: record.concurrency ?? 1,
    timeoutSeconds: record.timeout_seconds ?? 3600,
    workspacePolicy: record.workspace_policy ?? {},
    gitPolicy: record.git_policy ?? {},
    permissionPolicy: record.permission_policy ?? {},
    approvalPolicy: record.approval_policy ?? {},
    status: record.status === 'archived' ? 'archived' : 'active',
    visibility: (record.visibility as LocalProjectChatAgent['visibility']) ?? 'creator_admin',
    executionEnvironment:
      (record.execution_environment as LocalProjectChatAgent['executionEnvironment']) ?? 'local',
    executionMode: (record.execution_mode as LocalProjectChatAgent['executionMode']) ?? 'auto',
    executionDeviceId: record.execution_device_id ?? null,
    localProjectId: record.local_project_id ?? null,
    createdByUserId: record.created_by_user_id ?? null,
    version: record.version ?? 1,
    createdAt: record.created_at ?? '',
    updatedAt: record.updated_at ?? '',
  }
}

export function createLocalProjectChatAgentApi(request: LocalRequest, currentUserId?: number) {
  return {
    async list(projectId: string): Promise<LocalProjectChatAgent[]> {
      const records = await request<LocalAgentRecord[]>('chat_agents.list', {
        project_id: projectId,
      })
      return records.map(localAgent)
    },
    async create(
      projectId: string,
      input: {
        name: string
        runtime: 'codex'
        harness: LocalProjectChatAgent['harness']
        model?: string | null
        modelSelection?: Record<string, unknown> | null
        systemPrompt?: string
        skillRefs?: ProjectAgentResourceRef[]
        pluginRefs?: ProjectAgentResourceRef[]
        mcpServerRefs?: ProjectAgentResourceRef[]
        connectorRefs?: ProjectAgentResourceRef[]
        secretRefs?: ProjectAgentSecretRef[]
        concurrency?: number
        timeoutSeconds?: number
        workspacePolicy?: Record<string, unknown>
        gitPolicy?: Record<string, unknown>
        permissionPolicy?: Record<string, unknown>
        approvalPolicy?: Record<string, unknown>
        visibility?: LocalProjectChatAgent['visibility']
        executionEnvironment?: LocalProjectChatAgent['executionEnvironment']
        executionMode?: LocalProjectChatAgent['executionMode']
        executionDeviceId?: string | null
        localProjectId?: number | null
      }
    ): Promise<LocalProjectChatAgent> {
      const record = await request<LocalAgentRecord>('chat_agents.create', {
        project_id: projectId,
        agent: {
          name: input.name,
          harness: input.harness,
          model: input.model ?? null,
          model_selection: input.modelSelection ?? null,
          system_prompt: input.systemPrompt ?? '',
          skill_refs: input.skillRefs ?? [],
          plugin_refs: input.pluginRefs ?? [],
          mcp_server_refs: input.mcpServerRefs ?? [],
          connector_refs: input.connectorRefs ?? [],
          secret_refs: input.secretRefs ?? [],
          concurrency: input.concurrency ?? 1,
          timeout_seconds: input.timeoutSeconds ?? 3600,
          workspace_policy: input.workspacePolicy ?? {},
          git_policy: input.gitPolicy ?? {},
          permission_policy: input.permissionPolicy ?? {},
          approval_policy: input.approvalPolicy ?? {},
          visibility: input.visibility ?? 'creator_admin',
          execution_environment: input.executionEnvironment ?? 'local',
          execution_mode: input.executionMode ?? 'auto',
          execution_device_id: input.executionDeviceId ?? null,
          local_project_id: input.localProjectId ?? null,
          created_by_user_id: currentUserId ?? null,
        },
      })
      return localAgent(record)
    },
    async validate(
      _projectId: string,
      input: {
        name: string
        runtime: 'codex'
        harness?: LocalProjectChatAgent['harness']
        modelSelection?: Record<string, unknown> | null
        executionEnvironment?: LocalProjectChatAgent['executionEnvironment']
        executionDeviceId?: string | null
        localProjectId?: number | null
        secretRefs?: ProjectAgentSecretRef[]
        permissionPolicy?: Record<string, unknown>
      }
    ) {
      const issues: string[] = []
      if (!input.name.trim()) issues.push('Robot name is required')
      if (!input.executionDeviceId) issues.push('Execution device is required')
      if (input.executionEnvironment === 'local' && input.localProjectId == null) {
        issues.push('Local execution requires a bound code project')
      }
      if (input.harness && input.harness !== 'codex' && input.modelSelection == null) {
        issues.push('OpenCode and Claude Code robots require a model selection')
      }
      if (input.secretRefs?.length && !Object.keys(input.permissionPolicy ?? {}).length) {
        issues.push('Secret references require an explicit permission policy')
      }
      return { valid: issues.length === 0, issues }
    },
    async update(
      projectId: string,
      agentId: string,
      input: {
        version: number
        name?: string
        harness?: LocalProjectChatAgent['harness']
        model?: string | null
        modelSelection?: Record<string, unknown> | null
        systemPrompt?: string
        skillRefs?: ProjectAgentResourceRef[]
        pluginRefs?: ProjectAgentResourceRef[]
        mcpServerRefs?: ProjectAgentResourceRef[]
        connectorRefs?: ProjectAgentResourceRef[]
        secretRefs?: ProjectAgentSecretRef[]
        concurrency?: number
        timeoutSeconds?: number
        workspacePolicy?: Record<string, unknown>
        gitPolicy?: Record<string, unknown>
        permissionPolicy?: Record<string, unknown>
        approvalPolicy?: Record<string, unknown>
        status?: 'active' | 'archived'
        visibility?: LocalProjectChatAgent['visibility']
        executionEnvironment?: LocalProjectChatAgent['executionEnvironment']
        executionMode?: LocalProjectChatAgent['executionMode']
        executionDeviceId?: string | null
        localProjectId?: number | null
      }
    ): Promise<LocalProjectChatAgent> {
      const record = await request<LocalAgentRecord>('chat_agents.update', {
        project_id: projectId,
        agent_id: agentId,
        agent: {
          version: input.version,
          name: input.name,
          harness: input.harness,
          model: input.model,
          model_selection: input.modelSelection,
          system_prompt: input.systemPrompt,
          skill_refs: input.skillRefs,
          plugin_refs: input.pluginRefs,
          mcp_server_refs: input.mcpServerRefs,
          connector_refs: input.connectorRefs,
          secret_refs: input.secretRefs,
          concurrency: input.concurrency,
          timeout_seconds: input.timeoutSeconds,
          workspace_policy: input.workspacePolicy,
          git_policy: input.gitPolicy,
          permission_policy: input.permissionPolicy,
          approval_policy: input.approvalPolicy,
          status: input.status,
          visibility: input.visibility,
          execution_environment: input.executionEnvironment,
          execution_mode: input.executionMode,
          execution_device_id: input.executionDeviceId,
          local_project_id: input.localProjectId,
        },
      })
      return localAgent(record)
    },
    async archive(projectId: string, agentId: string, version: number) {
      await request('chat_agents.archive', {
        project_id: projectId,
        agent_id: agentId,
        version,
      })
      return { deleted: true }
    },
  }
}

export function createLocalLoopItemExecutionApi(request: LocalRequest) {
  return {
    async list(
      projectId: string,
      options: { agent_id?: string; status?: string; include_terminal?: boolean } = {}
    ): Promise<LocalLoopItemExecution[]> {
      return request<LocalLoopItemExecution[]>('executions.list', {
        project_id: projectId,
        agent_id: options.agent_id ?? null,
        status: options.status ?? null,
        include_terminal: options.include_terminal ?? false,
      })
    },
    async approve(executionId: number) {
      return request<LocalLoopItemExecution>('executions.approve', {
        execution_id: executionId,
      })
    },
    async reject(executionId: number, reason?: string) {
      return request<LocalLoopItemExecution>('executions.reject', {
        execution_id: executionId,
        reason: reason ?? null,
      })
    },
    async claimNext(claim: {
      execution_device_id?: string | null
      device_capacity?: number
      lease_seconds?: number
    }): Promise<LocalLoopItemExecution | null> {
      return request<LocalLoopItemExecution | null>('executions.claim_next', { claim })
    },
    async heartbeat(
      executionId: number,
      runtimeDeviceId: string | null,
      runtimeTaskId: string | null,
      leaseSeconds = 300
    ) {
      return request<LocalLoopItemExecution>('executions.heartbeat', {
        execution_id: executionId,
        runtime_device_id: runtimeDeviceId,
        runtime_task_id: runtimeTaskId,
        lease_seconds: leaseSeconds,
      })
    },
    async complete(executionId: number, note?: string | null) {
      return request<LocalLoopItemExecution>('executions.complete', {
        execution_id: executionId,
        note: note ?? null,
      })
    },
    async fail(executionId: number, error: string, requeue = true) {
      return request<LocalLoopItemExecution>('executions.fail', {
        execution_id: executionId,
        error,
        requeue,
      })
    },
    async recoverStale(): Promise<{ requeued: number; failed: number }> {
      return request<{ requeued: number; failed: number }>('executions.recover_stale', {})
    },
  }
}

export function createLocalProjectWorkflowApi(request: LocalRequest, currentUserId: number) {
  type LocalWorkflowAutomationConfig = {
    projectId: string
    userId: number
    workflowId: string
    repositoryBindingId?: string
    executionTarget: ProjectWorkflowAutomationInput['executionTarget']
    workspaceMode: ProjectWorkflowAutomationInput['workspaceMode']
    taskTemplate: Record<string, unknown>
    payloadMapping: Record<string, string>
    triggerType: ProjectWorkflowAutomationInput['triggerType']
    triggerConfig: Record<string, unknown>
    enabled: boolean
    description: string
  }
  type LocalAutomationRecord = Automation & {
    taskPayload?: {
      projectWorkflowAutomation?: LocalWorkflowAutomationConfig
    }
  }
  type LocalAutomationRun = AutomationRun & { workflowRunId?: string | null }

  const scheduleFor = (
    triggerType: ProjectWorkflowAutomationInput['triggerType'],
    config: Record<string, unknown>
  ) => {
    if (triggerType === 'cron') {
      return { type: 'cron', expression: String(config.expression || '0 9 * * *') }
    }
    if (triggerType === 'interval') {
      return {
        type: 'interval',
        value: Math.max(1, Number(config.value) || 1),
        unit: ['minutes', 'hours', 'days'].includes(String(config.unit))
          ? String(config.unit)
          : 'hours',
      }
    }
    if (triggerType === 'one_time') {
      return {
        type: 'one_time',
        execute_at: String(config.executeAt || config.execute_at || new Date().toISOString()),
      }
    }
    return { type: 'one_time', execute_at: '9999-12-31T23:59:59Z' }
  }

  const localAutomationView = (automation: LocalAutomationRecord): ProjectWorkflowAutomation => {
    const config = automation.taskPayload?.projectWorkflowAutomation
    if (!config) throw new Error('Local project workflow automation configuration is missing')
    return {
      id: automation.id,
      projectId: config.projectId,
      name: automation.name,
      description: config.description || automation.description,
      triggerType: config.triggerType,
      triggerConfig: config.triggerConfig,
      workflowId: config.workflowId,
      repositoryBindingId: config.repositoryBindingId || null,
      executionTarget: config.executionTarget,
      workspaceMode: config.workspaceMode,
      taskTemplate: config.taskTemplate,
      payloadMapping: config.payloadMapping,
      webhookConfigured: false,
      enabled: config.enabled,
      nextRunAt: automation.nextRunAt ?? null,
      lastRunAt: automation.lastRunAt ?? null,
      createdByUserId: config.userId,
      version: automation.version,
      createdAt: automation.createdAt,
      updatedAt: automation.updatedAt,
    }
  }

  const localAutomationRunView = (run: LocalAutomationRun): ProjectWorkflowAutomationRun => ({
    id: run.id,
    automationId: run.automationId,
    triggerType: run.trigger,
    status:
      run.status === 'needs_attention' || run.status === 'skipped'
        ? 'failed'
        : run.status === 'pending'
          ? 'pending'
          : run.status,
    loopItemId: run.taskId ?? null,
    workflowRunId: run.workflowRunId ?? null,
    scheduledFor: run.scheduledFor,
    startedAt: run.createdAt,
    completedAt: ['succeeded', 'failed', 'cancelled', 'skipped', 'needs_attention'].includes(
      run.status
    )
      ? run.updatedAt
      : null,
    errorMessage: run.error ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  })

  const automationPayload = (
    projectId: string,
    input: ProjectWorkflowAutomationInput,
    existing?: LocalAutomationRecord
  ) => {
    if (input.triggerType === 'webhook') {
      throw new Error('Webhook automations require a cloud project')
    }
    const timezone = String(input.triggerConfig.timezone || 'UTC')
    const enabled = input.enabled && !['manual', 'webhook'].includes(input.triggerType)
    return {
      id: existing?.id ?? '',
      version: existing?.version ?? 0,
      name: input.name,
      description: input.description,
      prompt: input.name,
      schedule: scheduleFor(input.triggerType, input.triggerConfig),
      timezone,
      enabled,
      conversationMode: 'independent',
      notificationPolicy: 'all_runs',
      taskPayload: {
        projectWorkflowAutomation: {
          projectId,
          userId: currentUserId,
          workflowId: input.workflowId,
          ...(input.repositoryBindingId ? { repositoryBindingId: input.repositoryBindingId } : {}),
          executionTarget: input.executionTarget,
          workspaceMode: input.workspaceMode,
          taskTemplate: input.taskTemplate,
          payloadMapping: input.payloadMapping,
          triggerType: input.triggerType,
          triggerConfig: input.triggerConfig,
          enabled: input.enabled,
          description: input.description,
        },
      },
      continuationPayload: null,
    }
  }

  const getLocalAutomation = async (automationId: string) => {
    const response = await request<{ automation: LocalAutomationRecord }>(
      'runtime.automations.get',
      { automationId }
    )
    return response.automation
  }

  return {
    listSquads: (projectId: string) =>
      request<ProjectAgentSquad[]>('project_workflows.squads.list', {
        project_id: projectId,
      }),
    createSquad: (projectId: string, input: ProjectAgentSquadInput) =>
      request<ProjectAgentSquad>('project_workflows.squads.create', {
        project_id: projectId,
        user_id: currentUserId,
        squad: input,
      }),
    updateSquad: (
      projectId: string,
      squadId: string,
      input: Partial<ProjectAgentSquadInput> & {
        version: number
        status?: ProjectAgentSquad['status']
      }
    ) =>
      request<ProjectAgentSquad>('project_workflows.squads.update', {
        project_id: projectId,
        squad_id: squadId,
        squad: input,
      }),
    previewSquadRoute: async (
      projectId: string,
      squadId: string,
      task: string
    ): Promise<SquadRoutePreview> => {
      const squad = (
        await request<ProjectAgentSquad[]>('project_workflows.squads.list', {
          project_id: projectId,
        })
      ).find(entry => entry.id === squadId)
      if (!squad) throw new Error('Robot squad not found')
      const orderedMembers = [
        squad.leaderAgentId,
        ...squad.memberAgentIds.filter(id => id !== squad.leaderAgentId),
      ].slice(0, squad.maxParallelMembers)
      return {
        squadId,
        leaderAgentId: squad.leaderAgentId,
        selectedMembers: orderedMembers.map(agentId => ({
          agentId,
          instruction: `Evaluate and execute this simulated task: ${task}`,
          requiredArtifacts: [],
          executionMode: 'parallel',
        })),
        explanation:
          'Preview only. Members are bounded by maxParallelMembers and no run was created.',
      }
    },
    listRepositories: (projectId: string) =>
      request<RepositoryBinding[]>('project_workflows.repositories.list', {
        project_id: projectId,
      }),
    createRepository: (projectId: string, input: RepositoryBindingInput) =>
      request<RepositoryBinding>('project_workflows.repositories.create', {
        project_id: projectId,
        user_id: currentUserId,
        repository: input,
      }),
    updateRepository: (
      projectId: string,
      bindingId: string,
      input: Partial<RepositoryBindingInput> & {
        version: number
        status?: RepositoryBinding['status']
      }
    ) =>
      request<RepositoryBinding>('project_workflows.repositories.update', {
        project_id: projectId,
        binding_id: bindingId,
        repository: input,
      }),
    validateRepository: (_projectId: string, bindingId: string) =>
      request<ConfigurationValidation>('project_workflows.repositories.validate', {
        binding_id: bindingId,
      }),
    listWorkflows: (projectId: string) =>
      request<WorkflowDefinition[]>('project_workflows.definitions.list', {
        project_id: projectId,
      }),
    createWorkflow: (projectId: string, input: WorkflowDefinitionInput) =>
      request<WorkflowDefinition>('project_workflows.definitions.create', {
        project_id: projectId,
        user_id: currentUserId,
        workflow: input,
      }),
    validateWorkflow: (_projectId: string, input: WorkflowDefinitionInput) =>
      request<ConfigurationValidation>('project_workflows.definitions.validate', {
        workflow: input,
      }),
    updateWorkflow: (
      projectId: string,
      workflowId: string,
      input: Partial<WorkflowDefinitionInput> & {
        version: number
        status?: WorkflowDefinition['status']
      }
    ) =>
      request<WorkflowDefinition>('project_workflows.definitions.update', {
        project_id: projectId,
        workflow_id: workflowId,
        workflow: input,
      }),
    async listAutomations(projectId: string) {
      const response = await request<{ items?: LocalAutomationRecord[] }>(
        'runtime.automations.list',
        {}
      )
      return (response.items ?? [])
        .filter(
          automation => automation.taskPayload?.projectWorkflowAutomation?.projectId === projectId
        )
        .map(localAutomationView)
    },
    async createAutomation(projectId: string, input: ProjectWorkflowAutomationInput) {
      const response = await request<{ automation: LocalAutomationRecord }>(
        'runtime.automations.create',
        { automation: automationPayload(projectId, input) }
      )
      return localAutomationView(response.automation)
    },
    async updateAutomation(
      projectId: string,
      automationId: string,
      input: Partial<ProjectWorkflowAutomationInput> & { version: number }
    ) {
      const existing = await getLocalAutomation(automationId)
      if (existing.version !== input.version) throw new Error('Automation version conflict')
      const current = localAutomationView(existing)
      const merged: ProjectWorkflowAutomationInput = {
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        triggerType: input.triggerType ?? current.triggerType,
        triggerConfig: input.triggerConfig ?? current.triggerConfig,
        workflowId: input.workflowId ?? current.workflowId,
        ...(input.repositoryBindingId !== undefined
          ? input.repositoryBindingId
            ? { repositoryBindingId: input.repositoryBindingId }
            : {}
          : current.repositoryBindingId
            ? { repositoryBindingId: current.repositoryBindingId }
            : {}),
        executionTarget: input.executionTarget ?? current.executionTarget,
        workspaceMode: input.workspaceMode ?? current.workspaceMode,
        taskTemplate: input.taskTemplate ?? current.taskTemplate,
        payloadMapping: input.payloadMapping ?? current.payloadMapping,
        enabled: input.enabled ?? current.enabled,
      }
      const response = await request<{ automation: LocalAutomationRecord }>(
        'runtime.automations.update',
        { automation: automationPayload(projectId, merged, existing) }
      )
      return localAutomationView(response.automation)
    },
    async rotateAutomationWebhook() {
      throw new Error('Webhook automations require a cloud project')
    },
    async listAutomationRuns(_projectId: string, automationId: string) {
      const response = await request<{ items?: LocalAutomationRun[] }>(
        'runtime.automation_runs.list',
        { automationId }
      )
      return (response.items ?? []).map(localAutomationRunView)
    },
    async runAutomation(_projectId: string, automationId: string) {
      const response = await request<{ run: LocalAutomationRun | null }>(
        'runtime.automations.run_now',
        { automationId }
      )
      if (!response.run) throw new Error('Automation run was not created')
      return localAutomationRunView(response.run)
    },
    getTaskBinding: (_projectId: string, itemId: string) =>
      request<TaskExecutionBinding | null>('project_workflows.bindings.get', {
        item_id: itemId,
      }),
    upsertTaskBinding: (projectId: string, itemId: string, input: TaskExecutionBindingInput) =>
      request<TaskExecutionBinding>('project_workflows.bindings.upsert', {
        project_id: projectId,
        item_id: itemId,
        user_id: currentUserId,
        binding: input,
      }),
    listRuns: (_projectId: string, itemId: string) =>
      request<WorkflowRun[]>('project_workflows.runs.list', { item_id: itemId }),
    getRun: (_projectId: string, _itemId: string, runId: string) =>
      request<WorkflowRunDetail>('project_workflows.runs.get', { run_id: runId }),
    getTaskDevelopment: (_projectId: string, itemId: string) =>
      request<TaskDevelopment[]>('project_workflows.development.get', {
        item_id: itemId,
      }),
    createPullRequest: async () => {
      throw new Error('Local project spaces do not have repository provider credentials')
    },
    refreshPullRequest: async () => {
      throw new Error('Local project spaces do not have repository provider credentials')
    },
    mergePullRequest: async () => {
      throw new Error('Local project spaces do not have repository provider credentials')
    },
    startRun: (
      projectId: string,
      itemId: string,
      idempotencyKey: string,
      triggerMessageId?: string
    ) =>
      request<WorkflowRun>('project_workflows.runs.start', {
        project_id: projectId,
        item_id: itemId,
        user_id: currentUserId,
        idempotency_key: idempotencyKey,
        trigger_message_id: triggerMessageId,
      }),
    approveStage: (
      projectId: string,
      _itemId: string,
      runId: string,
      stageId: string,
      version: number,
      reason?: string
    ) =>
      request<WorkflowRunDetail>('project_workflows.stages.approve', {
        project_id: projectId,
        run_id: runId,
        stage_id: stageId,
        version,
        reason,
      }),
    rejectStage: (
      projectId: string,
      _itemId: string,
      runId: string,
      stageId: string,
      version: number,
      reason?: string
    ) =>
      request<WorkflowRunDetail>('project_workflows.stages.reject', {
        project_id: projectId,
        run_id: runId,
        stage_id: stageId,
        version,
        reason,
      }),
    retryStage: (
      projectId: string,
      _itemId: string,
      runId: string,
      stageId: string,
      version: number
    ) =>
      request<WorkflowRunDetail>('project_workflows.stages.retry', {
        project_id: projectId,
        run_id: runId,
        stage_id: stageId,
        version,
      }),
    cancelRun: (_projectId: string, _itemId: string, runId: string, version: number) =>
      request<WorkflowRunDetail>('project_workflows.runs.cancel', {
        run_id: runId,
        version,
      }),
  }
}

function localTask(record: LocalLoopItemRecord, project?: CloudProject): CloudLoopItem {
  const role = project?.access_role ?? 'Owner'
  const isPublicVisitor = role === 'RestrictedAnalyst'
  const ownsTask =
    Boolean(project?.current_user_id) && record.created_by_user_id === project?.current_user_id
  return {
    id: record.id,
    cloud_project_id: record.cloud_project_id ?? '',
    sequence_number: record.sequence_number ?? 0,
    parent_id: record.parent_id,
    created_by_user_id: record.created_by_user_id,
    created_by_user_name:
      typeof record.metadata.creator_label === 'string'
        ? record.metadata.creator_label.split(':').slice(3).join(':').trim() || null
        : null,
    can_view_detail: !isPublicVisitor || ownsTask,
    can_edit: ['Owner', 'Maintainer', 'Developer'].includes(role) || ownsTask,
    assignee_user_id: record.assignee_user_id ?? null,
    execution_id: record.execution_id ?? null,
    execution_state: record.execution_state ?? null,
    assignee_name:
      typeof record.metadata.assignee_label === 'string'
        ? record.metadata.assignee_label || null
        : null,
    title: record.title ?? '',
    description: record.description,
    status: (record.status ?? 'inbox') as CloudLoopItem['status'],
    priority: (record.priority ?? 'none') as CloudLoopItem['priority'],
    due_at: typeof record.metadata.due_at === 'string' ? record.metadata.due_at || null : null,
    tags: stringList(record.metadata.tags),
    sort_order: record.sort_order,
    current_delivery_id: record.current_delivery_id,
    version: record.version,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
    source_status:
      typeof record.metadata.source_status === 'string' ? record.metadata.source_status : null,
    source_record_id:
      typeof record.metadata.record_id === 'string' ? record.metadata.record_id : null,
    source_cells:
      typeof record.metadata.source_cells === 'object' && record.metadata.source_cells !== null
        ? (record.metadata.source_cells as Record<string, unknown>)
        : {},
  }
}

function localProjectFile(record: LocalProjectFileRecord): CloudProjectFile {
  return {
    ...record,
    kind: record.kind === 'folder' ? 'folder' : 'file',
  }
}

function fileBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

async function fileInput(file: File) {
  return {
    display_name: file.name,
    content_type: file.type || null,
    base64: fileBytesToBase64(new Uint8Array(await file.arrayBuffer())),
  }
}

function localAccess(record: LocalAccessRecord) {
  return {
    url: convertFileSrc(record.path),
    expires_in_seconds: 0,
  }
}

function unsupported(name: string): never {
  throw new Error(`${name} is not available for local projects yet`)
}

export function createLocalDeliveryApi(
  request: LocalRequest
): NonNullable<WorkbenchServices['deliveryApi']> {
  const taskProjects = new Map<string, CloudProjectId>()
  const trackProjectTaskOnce = createProjectTaskTrackingSingleFlight()
  function rememberTasks(projectId: CloudProjectId, records: LocalLoopItemRecord[]) {
    for (const record of records) taskProjects.set(record.id, projectId)
  }

  async function resolveProjectId(itemId: string): Promise<CloudProjectId> {
    const known = taskProjects.get(itemId)
    if (known) return known
    const projectRecords = await request<LocalLoopItemRecord[]>('projects.list')
    const projects = projectRecords.map(localProject)
    const prefixMatches = projects.filter(project => itemId.startsWith(`${project.project_key}-`))
    if (prefixMatches.length === 1) return prefixMatches[0].id
    for (const project of projects) {
      try {
        const record = await request<LocalLoopItemRecord>('todos.get', {
          project_id: project.id,
          task_id: itemId,
        })
        taskProjects.set(record.id, project.id)
        return project.id
      } catch {
        // Read-only probing is safe when legacy projects reuse a project key.
      }
    }
    throw new Error('Local task not found')
  }

  const api = {
    async listCloudProjects() {
      const records = await request<LocalLoopItemRecord[]>('projects.list')
      return {
        items: records
          .filter(record => record.metadata.project_store !== 'backend')
          .map(localProject),
      }
    },
    async createCloudProject(data: {
      project_key?: string
      name: string
      description?: string
      task_provider?: 'local' | 'github' | 'gitlab' | 'dingtalk_aitable'
      provider_config?: {
        repository?: string
        domain?: string
        api_base?: string
        token?: string
        base_id?: string
        table_id?: string
        sheet_id?: string
        source_url?: string
        view_id?: string
        board_mapping?: Record<string, string>
        status_mode?: 'mapped' | 'custom'
        status_mapping?: Record<string, CloudLoopItem['status']>
        custom_statuses?: string[]
      }
    }) {
      const record = await request<LocalLoopItemRecord>('projects.create', {
        ...data,
        task_provider: data.task_provider ?? 'local',
        provider_config: data.provider_config ?? {},
      })
      return localProject(record)
    },
    async updateCloudProject(
      projectId: CloudProjectId,
      data: {
        name?: string
        description?: string
        tags?: string[]
        board_config?: CloudProject['board_config']
        card_display?: CloudProject['card_display']
        version: number
      }
    ) {
      const record = await request<LocalLoopItemRecord>('projects.update', {
        project_id: projectId,
        project: data,
      })
      return localProject(record)
    },
    async archiveCloudProject(projectId: CloudProjectId, version: number) {
      await request('projects.archive', {
        project_id: projectId,
        version,
      })
    },
    async listMyWork() {
      return { items: [] }
    },
    async listLoopItems(
      projectId: CloudProjectId,
      options: {
        assigneeType?: 'user'
        assigneeId?: string | number
      } = {}
    ) {
      const records = await request<LocalLoopItemRecord[]>('todos.list', {
        project_id: projectId,
      })
      rememberTasks(projectId, records)
      let items = records.map(record => localTask(record))
      if (options.assigneeType === 'user' && options.assigneeId !== undefined) {
        const userId = Number(options.assigneeId)
        items = items.filter(item => item.assignee_user_id === userId)
      }
      return { items }
    },
    async getLoopItem(itemId: string) {
      const projectId = await resolveProjectId(itemId)
      const record = await request<LocalLoopItemRecord>('todos.get', {
        project_id: projectId,
        task_id: itemId,
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async createLoopItem(
      projectId: CloudProjectId,
      data: {
        title: string
        description?: string
        status?: CloudLoopItem['status']
        priority?: CloudLoopItem['priority']
        due_at?: string
        parent_id?: string | null
        tags?: string[]
      }
    ) {
      const record = await request<LocalLoopItemRecord>('todos.create', {
        project_id: projectId,
        todo: {
          title: data.title,
          description: data.description ?? '',
          status: data.status ?? 'inbox',
          priority: data.priority ?? 'none',
          parent_id: data.parent_id ?? null,
          tags: data.tags ?? [],
        },
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async updateLoopItem(itemId: string, data: Record<string, unknown> & { version: number }) {
      const projectId = await resolveProjectId(itemId)
      const record = await request<LocalLoopItemRecord>('todos.update', {
        project_id: projectId,
        task_id: itemId,
        todo: data,
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async approveLoopItemRun(projectId: CloudProjectId, itemId: string): Promise<CloudLoopItem> {
      const executions = await request<LocalLoopItemExecution[]>('executions.list', {
        project_id: String(projectId),
        status: 'pending_approval',
      })
      const execution = executions.find(entry => entry.loop_item_id === String(itemId))
      if (!execution) throw new Error('Run is not waiting for robot approval')
      await request('executions.approve', { execution_id: execution.id })
      return api.getLoopItem(String(itemId))
    },
    async rejectLoopItemRun(
      projectId: CloudProjectId,
      itemId: string,
      _version: number,
      reason?: string
    ): Promise<CloudLoopItem> {
      const executions = await request<LocalLoopItemExecution[]>('executions.list', {
        project_id: String(projectId),
        status: 'pending_approval',
      })
      const execution = executions.find(entry => entry.loop_item_id === String(itemId))
      if (!execution) throw new Error('Run is not waiting for robot approval')
      await request('executions.reject', {
        execution_id: execution.id,
        reason: reason ?? null,
      })
      return api.getLoopItem(String(itemId))
    },
    async archiveLoopItem(itemId: string) {
      const projectId = await resolveProjectId(itemId)
      await request('todos.archive', {
        project_id: projectId,
        task_id: itemId,
      })
      taskProjects.delete(itemId)
    },
    async reorderLoopItems(
      projectId: CloudProjectId,
      data: {
        parent_id: string | null
        status: CloudLoopItem['status']
        item_ids: string[]
      }
    ) {
      const records = await request<LocalLoopItemRecord[]>('todos.reorder', {
        project_id: projectId,
        reorder: data,
      })
      rememberTasks(projectId, records)
      return { items: records.map(record => localTask(record)) }
    },
    async listLoopItemAttachments(itemId: string) {
      const projectId = await resolveProjectId(itemId)
      return request<CloudLoopItemAttachment[]>('attachments.list', {
        project_id: projectId,
        item_id: itemId,
      })
    },
    async addLoopItemAttachment(itemId: string, file: File) {
      const projectId = await resolveProjectId(itemId)
      return request<CloudLoopItemAttachment>('attachments.add', {
        project_id: projectId,
        item_id: itemId,
        file: await fileInput(file),
      })
    },
    async accessLoopItemAttachment(attachmentId: string) {
      return localAccess(
        await request<LocalAccessRecord>('attachments.access', {
          attachment_id: attachmentId,
        })
      )
    },
    async downloadLoopItemAttachment(attachmentId: string) {
      const access = await request<LocalAccessRecord>('attachments.access', {
        attachment_id: attachmentId,
      })
      await openLocalFile(access.path)
    },
    async deleteLoopItemAttachment(attachmentId: string) {
      await request('attachments.delete', { attachment_id: attachmentId })
    },
    async listTaskBindings(itemId: string) {
      const records = await request<LocalTaskBindingRecord[]>('todos.bindings', {
        task_id: itemId,
      })
      return records.map(record => ({ ...record, id: Number(record.id) }))
    },
    listLoopItemCollaborators: async () => [],
    addLoopItemCollaborator: async () => unsupported('Task collaborators'),
    removeLoopItemCollaborator: async () => unsupported('Task collaborators'),
    async bindTask(itemId: string, task: RuntimeTaskAddress, taskTitle?: string | null) {
      const projectId = await resolveProjectId(itemId)
      await request('todos.bind', {
        project_id: projectId,
        item_id: itemId,
        task: { ...task, ...(taskTitle ? { taskTitle } : {}) },
      })
    },
    async bindProjectTask(
      projectId: CloudProjectId,
      task: RuntimeTaskAddress,
      taskTitle?: string | null
    ) {
      await request('projects.bind_task', {
        project_id: projectId,
        task: { ...task, ...(taskTitle ? { taskTitle } : {}) },
      })
    },
    async trackProjectTask(
      projectId: CloudProjectId,
      task: RuntimeTaskAddress,
      taskTitle: string,
      description: string
    ) {
      return trackProjectTaskOnce(projectId, task, async () => {
        try {
          const existing = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
            device_id: task.deviceId,
            task_id: task.taskId,
          })
          if (existing.loop_item_id) {
            return { item: await api.getLoopItem(existing.loop_item_id) }
          }
        } catch {
          // Missing context is the expected first-run path.
        }
        const item = await api.createLoopItem(projectId, {
          title: taskTitle,
          description,
          status: 'in_progress',
        })
        await api.bindTask(item.id, task, taskTitle)
        return { item }
      })
    },
    async updateTaskTrackingStatus(
      task: RuntimeTaskAddress,
      executionStatus: 'running' | 'succeeded' | 'failed' | 'cancelled'
    ) {
      let binding: LocalTaskBindingRecord
      try {
        binding = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
          device_id: task.deviceId,
          task_id: task.taskId,
        })
      } catch {
        return null
      }
      if (!binding.loop_item_id) return null
      const item = await api.getLoopItem(binding.loop_item_id)
      const nextStatus = nextTaskTrackingStatus(item.status, executionStatus)
      return nextStatus
        ? api.updateLoopItem(item.id, { version: item.version, status: nextStatus })
        : item
    },
    async updateTaskTrackingTitle(task: RuntimeTaskAddress, title: string) {
      let binding: LocalTaskBindingRecord
      try {
        binding = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
          device_id: task.deviceId,
          task_id: task.taskId,
        })
      } catch {
        return null
      }
      if (!binding.loop_item_id) return null
      const item = await api.getLoopItem(binding.loop_item_id)
      return item.title === title
        ? item
        : api.updateLoopItem(item.id, { version: item.version, title })
    },
    async unbindCloudContext(task: RuntimeTaskAddress) {
      await request('runtime_tasks.unbind', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
    },
    async unbindTask(_itemId: string, task: RuntimeTaskAddress) {
      await request('runtime_tasks.unbind', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
    },
    async findLoopItemForTask(task: RuntimeTaskAddress) {
      const binding = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
      if (!binding.loop_item_id) throw new Error('Runtime task is linked to a project only')
      taskProjects.set(binding.loop_item_id, binding.cloud_project_id)
      return api.getLoopItem(binding.loop_item_id)
    },
    async findCloudContextForTask(task: RuntimeTaskAddress) {
      const binding = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
        device_id: task.deviceId,
        task_id: task.taskId,
      })
      const projectRecords = await request<LocalLoopItemRecord[]>('projects.list')
      const projectRecord = projectRecords.find(record => record.id === binding.cloud_project_id)
      if (!projectRecord) throw new Error('Local project not found')
      const loopItem = binding.loop_item_id ? await api.getLoopItem(binding.loop_item_id) : null
      return {
        ...binding,
        id: binding.id,
        project: localProject(projectRecord),
        loop_item: loopItem,
      }
    },
    listCloudProjectMembers: async (): Promise<CloudProjectMember[]> => [],
    addCloudProjectMember: async () => unsupported('Project members'),
    updateCloudProjectMember: async () => unsupported('Project members'),
    removeCloudProjectMember: async () => unsupported('Project members'),
    searchCloudProjectUsers: async () => ({ users: [], total: 0 }),
    async listCloudFiles(projectId: CloudProjectId) {
      const records = await request<LocalProjectFileRecord[]>('files.list', {
        project_id: projectId,
      })
      return { items: records.map(localProjectFile) }
    },
    listProjectDeliveryFiles: async () => ({ items: [] }),
    async createCloudFolder(projectId: CloudProjectId, path: string) {
      const record = await request<LocalProjectFileRecord>('files.create_folder', {
        project_id: projectId,
        path,
      })
      return localProjectFile(record)
    },
    async uploadCloudFile(projectId: CloudProjectId, file: File, path = file.name) {
      const record = await request<LocalProjectFileRecord>('files.upload', {
        project_id: projectId,
        path,
        file: await fileInput(file),
      })
      return localProjectFile(record)
    },
    async accessCloudFile(fileId: string) {
      return localAccess(await request<LocalAccessRecord>('files.access', { file_id: fileId }))
    },
    async accessDeliveryFile(assetId: string) {
      return localAccess(
        await request<LocalAccessRecord>('deliveries.access_asset', { asset_id: assetId })
      )
    },
    async moveCloudFile(fileId: string, path: string, version: number) {
      const record = await request<LocalProjectFileRecord>('files.move', {
        file_id: fileId,
        path,
        version,
      })
      return localProjectFile(record)
    },
    async deleteCloudFile(fileId: string, recursive = false) {
      await request('files.delete', { file_id: fileId, recursive })
    },
    async createDelivery(itemId: string, data: DeliveryCreateInput) {
      const projectId = await resolveProjectId(itemId)
      return request<Delivery>('deliveries.create', {
        project_id: projectId,
        item_id: itemId,
        delivery: data,
      })
    },
    async addAsset(deliveryId: string, file: File, relativePath: string) {
      return request<DeliveryAsset>('deliveries.add_asset', {
        delivery_id: deliveryId,
        relative_path: relativePath,
        file: await fileInput(file),
      })
    },
    async finalizeDelivery(deliveryId: string) {
      const delivery = await api.getDelivery(deliveryId)
      return request<Delivery>('deliveries.finalize', {
        item_id: delivery.loop_item_id,
        delivery_id: deliveryId,
      })
    },
    async discardDraft(deliveryId: string) {
      await request('deliveries.discard', { delivery_id: deliveryId })
    },
    async listDeliveries(itemId: string) {
      const records = await request<Delivery[]>('deliveries.list', { item_id: itemId })
      return { items: records }
    },
    async getDelivery(deliveryId: string) {
      return request<DeliveryDetail>('deliveries.get', { delivery_id: deliveryId })
    },
  }
  return api as unknown as NonNullable<WorkbenchServices['deliveryApi']>
}
