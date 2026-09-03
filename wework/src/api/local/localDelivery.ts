import {
  createProjectTaskTrackingSingleFlight,
  DEFAULT_WORK_ITEM_PROJECT_ID,
  enqueueIssueWorkflowMutation,
  enqueueTaskTrackingMutation,
  nextTaskTrackingStatus,
  type TaskExecutionStatus,
  type CloudLoopItemAttachment,
  type CloudLoopItem,
  type CloudLoopItemExecution,
  type CloudProject,
  type CloudProjectFile,
  type CloudProjectId,
  type CloudProjectMember,
  type ProjectBoardSnapshot,
  type CloudTaskContext,
  type ProjectTaskAttachment,
  type Delivery,
  type DeliveryAsset,
  type DeliveryCreateInput,
  type DeliveryDetail,
  type DeliveryFinalizeInput,
} from '@/api/deliveries'
import {
  attachIssueWorkflowDelivery,
  decideIssueWorkflowNode,
  reconcileIssueWorkflowForTaskBindings,
  updateIssueWorkflowForRuntime,
  workflowBoardStatus,
} from '@/api/issueWorkflow'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { openLocalFile } from '@/lib/local-terminal'
import { readDroppedFiles } from '@/desktop/droppedFiles'
import type { Attachment, RuntimeProjectPluginRef, RuntimeTaskAddress } from '@/types/api'
import {
  localProjectAssociationFromTags,
  localProjectAssociationTag,
  visibleLoopItemTags,
} from '@/api/localProjectAssociation'
import { desktopFileUrl } from '@/components/chat/assistantMarkdownLinks'

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
  assignee_agent_id?: string | null
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
  workflow_node_id?: string | null
  binding_type: 'system' | 'user'
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
  model: string | null
  systemPrompt: string
  status: 'active' | 'archived'
  visibility: 'private' | 'creator_admin' | 'public'
  executionEnvironment: 'local' | 'cloud'
  executionMode: 'auto' | 'manual_approval'
  executionDeviceId: string | null
  localProjectId: number | null
  maxConcurrentExecutions: number
  workspacePolicy: 'project' | 'git_worktree'
  plugins: RuntimeProjectPluginRef[]
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
  runtime_instance_id?: string | null
  status: string
  display_state: string
  observed_state: string
  sync_state: string
  priority_weight: number
  queued_at?: string | null
  started_at?: string | null
  completed_at?: string | null
  lease_expires_at?: string | null
  heartbeat_at?: string | null
  claimed_at?: string | null
  start_requested_at?: string | null
  observed_at?: string | null
  cancel_requested_at?: string | null
  attempt_no: number
  previous_execution_id?: number | null
  execution_scope: string
  last_event_seq: number
  termination_reason: string
  retry_attempt: number
  max_retries?: number
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
  agent_max_concurrent_executions: number
  agent_plugins?: RuntimeProjectPluginRef[]
  /** Available only on a successful claim and never persisted with the queue row. */
  runtime_payload?: Record<string, unknown> | null
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
    pull_request_automation:
      record.metadata.pull_request_automation &&
      typeof record.metadata.pull_request_automation === 'object' &&
      !Array.isArray(record.metadata.pull_request_automation)
        ? (record.metadata.pull_request_automation as CloudProject['pull_request_automation'])
        : undefined,
    workflow_definition:
      record.metadata.workflow_definition &&
      typeof record.metadata.workflow_definition === 'object' &&
      !Array.isArray(record.metadata.workflow_definition)
        ? (record.metadata.workflow_definition as CloudProject['workflow_definition'])
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
        local_project_id?: number | null
        local_project_name?: string | null
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
      const localProjectLabel =
        data.local_project_id && data.local_project_name
          ? [
              localProjectAssociationTag({
                id: data.local_project_id,
                name: data.local_project_name,
              }),
            ]
          : []
      const record = await request<LocalLoopItemRecord>('external_todos.create', {
        project: externalProjectDescriptor(project),
        todo: {
          title: data.title,
          description: data.description ?? '',
          status: data.status ?? 'inbox',
          priority: data.priority ?? 'none',
          parent_id: data.parent_id ?? null,
          tags: [...(data.tags ?? []), ...creatorLabel, ...localProjectLabel],
        },
      })
      return localTask(record, project)
    },
    async updateLoopItem(
      project: CloudProject,
      itemId: string,
      data: Record<string, unknown> & { version: number }
    ) {
      let todo = data
      if (Array.isArray(data.tags)) {
        const current = await request<LocalLoopItemRecord>('external_todos.get', {
          project: externalProjectDescriptor(project),
          task_id: itemId,
        })
        const association = localProjectAssociationFromTags(stringList(current.metadata.tags))
        todo = {
          ...data,
          tags: association
            ? [
                ...visibleLoopItemTags(stringList(data.tags)),
                localProjectAssociationTag(association),
              ]
            : data.tags,
        }
      }
      const record = await request<LocalLoopItemRecord>('external_todos.update', {
        project: externalProjectDescriptor(project),
        task_id: itemId,
        todo,
      })
      return localTask(record, project)
    },
  }
}

type LocalAgentRecord = Record<string, unknown> & {
  id: string
  project_id?: string
  name?: string
  model?: string | null
  system_prompt?: string
  status?: string
  visibility?: string
  execution_environment?: string
  execution_mode?: string
  execution_device_id?: string | null
  local_project_id?: number | null
  max_concurrent_executions?: number
  workspace_policy?: 'project' | 'git_worktree'
  plugins?: RuntimeProjectPluginRef[]
  created_by_user_id?: number | null
  version?: number
  created_at?: string
  updated_at?: string
}

function localAgent(record: LocalAgentRecord): LocalProjectChatAgent {
  const maxConcurrentExecutions =
    typeof record.max_concurrent_executions === 'number' &&
    Number.isInteger(record.max_concurrent_executions) &&
    record.max_concurrent_executions >= 1 &&
    record.max_concurrent_executions <= 20
      ? record.max_concurrent_executions
      : 1
  return {
    id: record.id,
    projectId: record.project_id ?? '',
    name: record.name ?? 'AI',
    runtime: 'codex',
    model: record.model ?? null,
    systemPrompt: record.system_prompt ?? '',
    status: record.status === 'archived' ? 'archived' : 'active',
    visibility: (record.visibility as LocalProjectChatAgent['visibility']) ?? 'creator_admin',
    executionEnvironment:
      (record.execution_environment as LocalProjectChatAgent['executionEnvironment']) ?? 'local',
    executionMode: (record.execution_mode as LocalProjectChatAgent['executionMode']) ?? 'auto',
    executionDeviceId: record.execution_device_id ?? null,
    localProjectId: record.local_project_id ?? null,
    maxConcurrentExecutions,
    workspacePolicy: record.workspace_policy === 'git_worktree' ? 'git_worktree' : 'project',
    plugins: record.plugins ?? [],
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
        runtime: 'codex' | 'wegent'
        wegentTeamId?: number | null
        model?: string | null
        systemPrompt?: string
        visibility?: LocalProjectChatAgent['visibility']
        executionEnvironment?: LocalProjectChatAgent['executionEnvironment']
        executionMode?: LocalProjectChatAgent['executionMode']
        executionDeviceId?: string | null
        localProjectId?: number | null
        maxConcurrentExecutions?: number
        workspacePolicy?: LocalProjectChatAgent['workspacePolicy']
        plugins?: RuntimeProjectPluginRef[]
      }
    ): Promise<LocalProjectChatAgent> {
      if (input.runtime !== 'codex') {
        throw new Error('Local project robots only support the Wework runtime')
      }
      const record = await request<LocalAgentRecord>('chat_agents.create', {
        project_id: projectId,
        agent: {
          name: input.name,
          model: input.model ?? null,
          system_prompt: input.systemPrompt ?? '',
          visibility: input.visibility ?? 'creator_admin',
          execution_environment: input.executionEnvironment ?? 'local',
          execution_mode: input.executionMode ?? 'auto',
          execution_device_id: input.executionDeviceId ?? null,
          local_project_id: input.localProjectId ?? null,
          max_concurrent_executions: input.maxConcurrentExecutions ?? 1,
          workspace_policy: input.workspacePolicy ?? 'project',
          plugins: input.plugins ?? [],
          created_by_user_id: currentUserId ?? null,
        },
      })
      return localAgent(record)
    },
    async update(
      projectId: string,
      agentId: string,
      input: {
        version: number
        runtime?: 'codex' | 'wegent'
        wegentTeamId?: number | null
        name?: string
        model?: string | null
        systemPrompt?: string
        status?: 'active' | 'archived'
        visibility?: LocalProjectChatAgent['visibility']
        executionEnvironment?: LocalProjectChatAgent['executionEnvironment']
        executionMode?: LocalProjectChatAgent['executionMode']
        executionDeviceId?: string | null
        localProjectId?: number | null
        maxConcurrentExecutions?: number
        workspacePolicy?: LocalProjectChatAgent['workspacePolicy']
        plugins?: RuntimeProjectPluginRef[]
      }
    ): Promise<LocalProjectChatAgent> {
      if (input.runtime && input.runtime !== 'codex') {
        throw new Error('Local project robots only support the Wework runtime')
      }
      const record = await request<LocalAgentRecord>('chat_agents.update', {
        project_id: projectId,
        agent_id: agentId,
        agent: {
          version: input.version,
          name: input.name,
          model: input.model,
          system_prompt: input.systemPrompt,
          status: input.status,
          visibility: input.visibility,
          execution_environment: input.executionEnvironment,
          execution_mode: input.executionMode,
          execution_device_id: input.executionDeviceId,
          local_project_id: input.localProjectId,
          max_concurrent_executions: input.maxConcurrentExecutions,
          workspace_policy: input.workspacePolicy,
          plugins: input.plugins,
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
    async cancel(executionId: number, note?: string) {
      return request<LocalLoopItemExecution>('executions.cancel', {
        execution_id: executionId,
        note: note ?? null,
      })
    },
    async claimNext(claim: {
      execution_device_id?: string | null
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
    async startRequested(
      executionId: number,
      runtimeDeviceId: string,
      runtimeTaskId: string,
      leaseSeconds = 300
    ) {
      return request<LocalLoopItemExecution | null>('executions.start_requested', {
        execution_id: executionId,
        runtime_device_id: runtimeDeviceId,
        runtime_task_id: runtimeTaskId,
        lease_seconds: leaseSeconds,
      })
    },
    async runtimeStart(
      executionId: number,
      runtimeDeviceId: string,
      runtimeTaskId: string,
      leaseSeconds = 300
    ) {
      return request<LocalLoopItemExecution | null>('executions.runtime_start', {
        execution_id: executionId,
        runtime_device_id: runtimeDeviceId,
        runtime_task_id: runtimeTaskId,
        lease_seconds: leaseSeconds,
      })
    },
    async dispatchUnknown(
      executionId: number,
      runtimeDeviceId: string,
      runtimeTaskId: string,
      error: string
    ) {
      return request<LocalLoopItemExecution | null>('executions.dispatch_unknown', {
        execution_id: executionId,
        runtime_device_id: runtimeDeviceId,
        runtime_task_id: runtimeTaskId,
        error,
      })
    },
    async dispatchFailed(executionId: number, error: string) {
      return request<LocalLoopItemExecution>('executions.dispatch_failed', {
        execution_id: executionId,
        error,
      })
    },
    async recoverStale(): Promise<{ requeued: number; unknown: number }> {
      return request<{ requeued: number; unknown: number }>('executions.recover_stale', {})
    },
    async listStale(): Promise<LocalLoopItemExecution[]> {
      return request<LocalLoopItemExecution[]>('executions.list_stale', {})
    },
    async reconcile(
      executionId: number,
      snapshot: { runtime_status: string; running: boolean; turn_status?: string | null }
    ) {
      return request<LocalLoopItemExecution | null>('executions.reconcile', {
        execution_id: executionId,
        ...snapshot,
      })
    },
  }
}

function localTask(record: LocalLoopItemRecord, project?: CloudProject): CloudLoopItem {
  const role = project?.access_role ?? 'Owner'
  const isPublicVisitor = role === 'RestrictedAnalyst'
  const ownsTask =
    Boolean(project?.current_user_id) && record.created_by_user_id === project?.current_user_id
  const storedTags = stringList(record.metadata.tags)
  const localProjectAssociation = localProjectAssociationFromTags(storedTags)
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
    content_revision: 1,
    is_unread: false,
    assignee_user_id: record.assignee_user_id ?? null,
    assignee_agent_id: record.assignee_agent_id ?? null,
    execution_id: record.execution_id ?? null,
    execution_state: record.execution_state ?? null,
    workflow:
      record.metadata.workflow &&
      typeof record.metadata.workflow === 'object' &&
      !Array.isArray(record.metadata.workflow)
        ? (record.metadata.workflow as CloudLoopItem['workflow'])
        : null,
    execution_config:
      record.metadata.execution_config &&
      typeof record.metadata.execution_config === 'object' &&
      !Array.isArray(record.metadata.execution_config)
        ? (record.metadata.execution_config as CloudLoopItem['execution_config'])
        : null,
    local_project_id: localProjectAssociation?.id ?? null,
    local_project_name: localProjectAssociation?.name || null,
    assignee_name:
      typeof record.metadata.assignee_label === 'string'
        ? record.metadata.assignee_label || null
        : null,
    title: record.title ?? '',
    description: record.description,
    status: (record.status ?? 'inbox') as CloudLoopItem['status'],
    priority: (record.priority ?? 'none') as CloudLoopItem['priority'],
    due_at: typeof record.metadata.due_at === 'string' ? record.metadata.due_at || null : null,
    tags: visibleLoopItemTags(storedTags),
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
    url: desktopFileUrl(record.path),
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
        pull_request_automation?: CloudProject['pull_request_automation']
        workflow_definition?: CloudProject['workflow_definition']
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
        assigneeType?: 'user' | 'agent'
        assigneeId?: string | number
      } = {}
    ) {
      const records = await request<LocalLoopItemRecord[]>('todos.list', {
        project_id: projectId,
      })
      rememberTasks(projectId, records)
      let items = records.map(record => localTask(record))
      if (options.assigneeType === 'agent' && options.assigneeId !== undefined) {
        const agentId = String(options.assigneeId)
        items = items.filter(item => item.assignee_agent_id === agentId)
      } else if (options.assigneeType === 'user' && options.assigneeId !== undefined) {
        const userId = Number(options.assigneeId)
        items = items.filter(item => item.assignee_user_id === userId)
      }
      return { items }
    },
    async listLoopItemsPage(
      projectId: CloudProjectId,
      options: {
        status: CloudLoopItem['status']
        parentId: string | null
        cursor?: string | null
        limit?: number
      }
    ) {
      const response = await api.listLoopItems(projectId)
      const offset = Number(options.cursor ?? 0)
      const limit = options.limit ?? 10
      const matching = response.items.filter(
        item => item.status === options.status && item.parent_id === options.parentId
      )
      const items = matching.slice(offset, offset + limit)
      const nextOffset = offset + items.length
      return {
        items,
        task_bindings: [],
        next_cursor: nextOffset < matching.length ? String(nextOffset) : null,
      }
    },
    async getBoardSnapshot(projectId: CloudProjectId): Promise<ProjectBoardSnapshot> {
      const records = await request<LocalLoopItemRecord[]>('todos.list', {
        project_id: projectId,
      })
      rememberTasks(projectId, records)
      const items = records.map(record => localTask(record))
      const taskBindings = await request<LocalTaskBindingRecord[]>('todos.bindings.batch', {
        task_ids: items.map(item => item.id),
      })
      return {
        items,
        task_bindings: taskBindings.map(record => ({
          ...record,
          id: Number(record.id),
        })),
        members: [],
        agents: [],
      }
    },
    async listLoopItemExecutions(
      projectId: CloudProjectId,
      options: { agent_id?: string; status?: string } = {}
    ): Promise<{ items: CloudLoopItemExecution[] }> {
      const records = await request<LocalLoopItemExecution[]>('executions.list', {
        project_id: String(projectId),
        agent_id: options.agent_id ?? null,
        status: options.status ?? null,
      })
      return {
        items: records.map(record => ({
          ...record,
          executor_type: 'project_robot',
          team_id: null,
          backend_task_id: null,
          automation_run_id: '',
        })),
      }
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
        local_project_id?: number | null
        local_project_name?: string | null
        workflow?: CloudLoopItem['workflow']
        execution_config?: CloudLoopItem['execution_config']
        automation_rule_id?: string | null
      }
    ) {
      const localProjectLabel =
        data.local_project_id && data.local_project_name
          ? [
              localProjectAssociationTag({
                id: data.local_project_id,
                name: data.local_project_name,
              }),
            ]
          : []
      const record = await request<LocalLoopItemRecord>('todos.create', {
        project_id: projectId,
        todo: {
          title: data.title,
          description: data.description ?? '',
          status: data.status ?? 'inbox',
          priority: data.priority ?? 'none',
          parent_id: data.parent_id ?? null,
          tags: [...(data.tags ?? []), ...localProjectLabel],
          ...(data.workflow ? { workflow: data.workflow } : {}),
          ...(data.execution_config ? { execution_config: data.execution_config } : {}),
        },
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async updateLoopItem(itemId: string, data: Record<string, unknown> & { version: number }) {
      const projectId = await resolveProjectId(itemId)
      let todo = data
      if (Array.isArray(data.tags)) {
        const current = await request<LocalLoopItemRecord>('todos.get', {
          project_id: projectId,
          task_id: itemId,
        })
        const association = localProjectAssociationFromTags(stringList(current.metadata.tags))
        todo = {
          ...data,
          tags: association
            ? [
                ...visibleLoopItemTags(stringList(data.tags)),
                localProjectAssociationTag(association),
              ]
            : data.tags,
        }
      }
      const record = await request<LocalLoopItemRecord>('todos.update', {
        project_id: projectId,
        task_id: itemId,
        todo,
      })
      taskProjects.set(record.id, projectId)
      return localTask(record)
    },
    async markLoopItemRead(itemId: string) {
      return api.getLoopItem(itemId)
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
    async listProjectTaskAttachments(projectId: CloudProjectId) {
      const tasks = await api.listLoopItems(projectId)
      const rows = await Promise.all(
        tasks.items.map(async item => {
          const attachments = await request<CloudLoopItemAttachment[]>('attachments.list', {
            project_id: projectId,
            item_id: item.id,
          })
          return attachments.map(attachment => ({
            ...attachment,
            loop_item_title: item.title,
          }))
        })
      )
      return {
        items: rows
          .flat()
          .sort((left, right) =>
            right.created_at.localeCompare(left.created_at)
          ) as ProjectTaskAttachment[],
      }
    },
    async importLoopItemAttachments(itemId: string, attachments: Attachment[]) {
      const files = await readDroppedFiles(
        attachments
          .filter(attachment => Boolean(attachment.local_path?.trim()))
          .map(attachment => attachment.local_path!)
      )
      const imported: CloudLoopItemAttachment[] = []
      for (const file of files) {
        imported.push(await api.addLoopItemAttachment(itemId, file))
      }
      return imported
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
    async readLoopItemAttachment(attachmentId: string) {
      const access = await request<LocalAccessRecord>('attachments.access', {
        attachment_id: attachmentId,
      })
      const [file] = await readDroppedFiles([access.path])
      return file
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
    async bindTask(
      itemId: string,
      task: RuntimeTaskAddress,
      taskTitle?: string | null,
      workflowNodeId?: string | null
    ) {
      const projectId = await resolveProjectId(itemId)
      await request('todos.bind', {
        project_id: projectId,
        item_id: itemId,
        task: {
          ...task,
          ...(taskTitle ? { taskTitle } : {}),
          ...(workflowNodeId ? { workflowNodeId } : {}),
        },
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
          const existing = await request<LocalTaskBindingRecord>(
            String(projectId) === DEFAULT_WORK_ITEM_PROJECT_ID
              ? 'runtime_tasks.system_context'
              : 'runtime_tasks.user_context',
            {
              device_id: task.deviceId,
              task_id: task.taskId,
            }
          )
          if (existing.loop_item_id && String(existing.cloud_project_id) === String(projectId)) {
            return { item: await api.getLoopItem(existing.loop_item_id) }
          }
        } catch {
          // Missing context is the expected first-run path.
        }
        const item = await api.createLoopItem(projectId, {
          title: taskTitle,
          description,
          status: String(projectId) === DEFAULT_WORK_ITEM_PROJECT_ID ? 'inbox' : 'pending',
        })
        await api.bindTask(item.id, task, taskTitle)
        return { item }
      })
    },
    async updateTaskTrackingStatus(task: RuntimeTaskAddress, executionStatus: TaskExecutionStatus) {
      return enqueueTaskTrackingMutation(task, async () => {
        console.info('[IssueTaskStatusSync] local status update requested', {
          deviceId: task.deviceId,
          taskId: task.taskId,
          executionStatus,
        })
        let context: CloudTaskContext
        try {
          const binding = await request<LocalTaskBindingRecord>('runtime_tasks.context', {
            device_id: task.deviceId,
            task_id: task.taskId,
          })
          console.info('[IssueTaskStatusSync] local task binding resolved', {
            deviceId: task.deviceId,
            taskId: task.taskId,
            executionStatus,
            bindingType: binding.binding_type,
            loopItemId: binding.loop_item_id,
            workflowNodeId: binding.workflow_node_id,
          })
          const projectRecords = await request<LocalLoopItemRecord[]>('projects.list')
          const projectRecord = projectRecords.find(
            record => record.id === binding.cloud_project_id
          )
          if (!projectRecord) return null
          context = {
            ...binding,
            id: binding.id,
            project: localProject(projectRecord),
            loop_item: binding.loop_item_id ? await api.getLoopItem(binding.loop_item_id) : null,
          }
        } catch (error) {
          console.warn('[IssueTaskStatusSync] local task binding lookup failed', {
            deviceId: task.deviceId,
            taskId: task.taskId,
            executionStatus,
            error: error instanceof Error ? error.message : String(error),
          })
          return null
        }
        if (!context.loop_item_id || !context.loop_item) return null
        const item = context.loop_item
        if (executionStatus !== 'queued' && item.workflow && context.workflow_node_id) {
          return enqueueIssueWorkflowMutation(item.id, async () => {
            const current = await api.getLoopItem(item.id)
            if (!current.workflow) return current
            const bindings = await api.listTaskBindings(item.id)
            const stageTaskIds = bindings
              .filter(binding => binding.workflow_node_id === context.workflow_node_id)
              .map(binding => `${binding.device_id}:${binding.task_id}`)
            const workflow = updateIssueWorkflowForRuntime(
              current.workflow,
              context.workflow_node_id!,
              executionStatus,
              `${task.deviceId}:${task.taskId}`,
              stageTaskIds
            )
            const updated = await api.updateLoopItem(current.id, {
              version: current.version,
              workflow,
              status: workflowBoardStatus(workflow),
            })
            console.info('[IssueTaskStatusSync] local workflow task status persisted', {
              deviceId: task.deviceId,
              taskId: task.taskId,
              executionStatus,
              loopItemId: updated.id,
              workflowNodeId: context.workflow_node_id,
            })
            return updated
          })
        }
        if (executionStatus === 'succeeded') {
          const bindings = await api.listTaskBindings(item.id)
          if (bindings.length > 1) return item
        }
        const nextStatus = nextTaskTrackingStatus(item.status, executionStatus)
        return nextStatus
          ? api.updateLoopItem(item.id, { version: item.version, status: nextStatus })
          : item
      })
    },
    async updateTaskTrackingTitle(task: RuntimeTaskAddress, title: string) {
      return enqueueTaskTrackingMutation(task, async () => {
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
      })
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
        item_id: _itemId,
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
    async readCloudFile(fileId: string) {
      const access = await request<LocalAccessRecord>('files.access', { file_id: fileId })
      const [file] = await readDroppedFiles([access.path])
      return file
    },
    async accessDeliveryFile(assetId: string) {
      return localAccess(
        await request<LocalAccessRecord>('deliveries.access_asset', { asset_id: assetId })
      )
    },
    async readDeliveryFile(assetId: string) {
      const access = await request<LocalAccessRecord>('deliveries.access_asset', {
        asset_id: assetId,
      })
      const [file] = await readDroppedFiles([access.path])
      return file
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
    async finalizeDelivery(
      deliveryId: string,
      input: DeliveryFinalizeInput = { fulfillments: [] }
    ) {
      const delivery = await api.getDelivery(deliveryId)
      const finalized = await request<Delivery>('deliveries.finalize', {
        item_id: delivery.loop_item_id,
        delivery_id: deliveryId,
        finalize: input,
      })
      if (delivery.source_task_binding_id) {
        const bindings = await api.listTaskBindings(delivery.loop_item_id)
        const binding = bindings.find(candidate => candidate.id === delivery.source_task_binding_id)
        if (binding?.workflow_node_id) {
          const item = await api.getLoopItem(delivery.loop_item_id)
          if (item.workflow) {
            const workflow = attachIssueWorkflowDelivery(
              item.workflow,
              binding.workflow_node_id,
              deliveryId,
              input.fulfillments.map(fulfillment => fulfillment.requirement_id)
            )
            await api.updateLoopItem(item.id, {
              version: item.version,
              workflow,
              status: workflowBoardStatus(workflow),
            })
          }
        }
      }
      return finalized
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
    async decideWorkflowNode(
      itemId: string,
      workflowNodeId: string,
      action: 'approve' | 'reject' | 'force_advance',
      reason = '',
      actorUserId?: number
    ) {
      const item = await api.getLoopItem(itemId)
      if (!item.workflow) throw new Error('Issue has no workflow')
      const bindings = await api.listTaskBindings(itemId)
      const workflow = decideIssueWorkflowNode(
        reconcileIssueWorkflowForTaskBindings(item.workflow, bindings),
        workflowNodeId,
        action,
        actorUserId ?? Number(item.created_by_user_id),
        reason
      )
      return api.updateLoopItem(item.id, {
        version: item.version,
        workflow,
        status: workflowBoardStatus(workflow),
      })
    },
  }
  return api as unknown as NonNullable<WorkbenchServices['deliveryApi']>
}
