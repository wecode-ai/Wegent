import { ApiError, type HttpClient } from './http'
import type { ProjectChatAgent } from './projectChatAgents'
import type { ProjectChatWorkspaceBindingInput } from './projectChatAgents'
import type {
  Attachment,
  ModelType,
  RuntimeAdditionalContext,
  RuntimeGoalCreateInput,
  RuntimeProjectPluginRef,
  RuntimeSupervisorCreateInput,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  SkillRef,
} from '@/types/api'
import { saveBlobToDownloads } from '@/lib/blobDownload'

export type CloudProjectId = string
type CloudProjectIdInput = CloudProjectId | number

export interface DeliveryAsset {
  id: string
  kind: string
  display_name: string
  relative_path: string
  content_type: string | null
  size_bytes: number
  sha256: string
}

export interface Delivery {
  id: string
  loop_item_id: string
  created_by_user_id: number
  source_task_binding_id: number | null
  source_task_snapshot: Record<string, unknown> | null
  status: 'draft' | 'delivered'
  created_at: string
  delivered_at: string | null
  assets: DeliveryAsset[]
  fulfillments: DeliveryFulfillment[]
}

export interface DeliveryDetail extends Delivery {
  markdown: string
  chat: Record<string, unknown> | null
}

export interface DeliveryCreateInput {
  markdown: string
  chat?: Record<string, unknown>
  source_task?: RuntimeTaskAddress
}

export type DeliverableValueType =
  | 'text'
  | 'file'
  | 'code_snapshot'
  | 'git_branch'
  | 'pull_request'
  | 'url'

export interface DeliverableRequirement {
  id: string
  name: string
  description: string
  value_type: DeliverableValueType
  file_constraints?: {
    accepted_types: string[]
    min_files: number
    max_files: number
  } | null
}

export type DeliveryFulfillment =
  | { requirement_id: string; kind: 'text'; text: string }
  | { requirement_id: string; kind: 'file'; asset_ids: string[] }
  | {
      requirement_id: string
      kind: 'code_snapshot'
      asset_id: string
      changed_files: string[]
      base_revision?: string | null
      head_revision?: string | null
      sha256: string
    }
  | {
      requirement_id: string
      kind: 'git_branch'
      remote_url: string
      branch: string
      commit_sha: string
    }
  | {
      requirement_id: string
      kind: 'pull_request'
      provider: 'github' | 'gitlab'
      url: string
      number: number
      state: 'draft'
      head_branch: string
      base_branch: string
      head_commit: string
    }
  | { requirement_id: string; kind: 'url'; url: string; title: string }

export interface DeliveryFinalizeInput {
  fulfillments: DeliveryFulfillment[]
}

export interface CloudLoopItem {
  id: string
  cloud_project_id: CloudProjectId
  sequence_number: number
  parent_id: string | null
  created_by_user_id: number
  created_by_user_name?: string | null
  can_view_detail?: boolean
  can_edit?: boolean
  detail_loaded?: boolean
  content_revision?: number
  is_unread?: boolean
  assignee_user_id: number | null
  assignee_name?: string | null
  assignee_agent_id?: string | null
  assignee_agent_name?: string | null
  assignee_team_id?: number | null
  assignee_team_name?: string | null
  execution_id?: number | null
  execution_state?: string | null
  execution_control_state?: string | null
  execution_observed_state?: string | null
  execution_sync_state?: string | null
  execution_attempt_no?: number | null
  execution_last_event_seq?: number | null
  can_approve?: boolean
  assignment_history?: Array<{
    by_user_id: number
    to_type: 'user' | 'agent' | 'team' | null
    to_id: string | null
    to_name?: string | null
    action: 'assign' | 'reassign' | 'unassign'
    at: string
  }>
  status_history?: Array<{
    from_status: string
    from_status_name?: string | null
    to_status: string
    to_status_name?: string | null
    trigger:
      | 'create'
      | 'user_update'
      | 'ai_started'
      | 'ai_completed'
      | 'task_started'
      | 'delivery'
      | 'status_removed'
      | 'workflow_plan_approved'
      | 'workflow_task_progress'
      | 'workflow_outcome_passed'
      | 'workflow_outcome_needs_rework'
      | 'workflow_review_approved'
      | 'workflow_stage_advanced'
      | 'workflow_replanned'
      | 'workflow_paused'
      | 'workflow_resumed'
    by_user_id: number | null
    at: string
  }>
  approval?: {
    status: 'pending' | 'approved' | 'rejected'
    requested_at?: string
    approved_by_user_id?: number
    approved_at?: string
    rejected_by_user_id?: number
    rejected_at?: string
    reason?: string | null
  } | null
  queued_at?: string | null
  execution_note?: string | null
  execution_error?: string | null
  automation?: {
    rule_id?: string
    run_id?: string
    trigger?: 'scheduled' | 'manual' | string
    scheduled_for?: string | null
    bug_key?: string
  } | null
  workflow?: IssueWorkflowInstance | null
  execution_config?: WorkflowExecutionConfig | null
  ai_state?: {
    run_id?: string
    status?: string
    agent_id?: string | null
    team_id?: number | null
    agent_name?: string | null
    trigger_message_id?: string | null
    project_chat_message_id?: string | null
    runtime_device_id?: string | null
    runtime_task_id?: string | null
    started_at?: string | null
    heartbeat_at?: string | null
    lease_expires_at?: string | null
    completed_at?: string | null
    updated_at?: string | null
    last_error?: string | null
    auto_retry?: boolean
    auto_retry_count?: number
  } | null
  local_project_id?: number | null
  local_project_name?: string | null
  title: string
  description: string
  status: string
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  due_at: string | null
  tags: string[]
  sort_order: number
  current_delivery_id: string | null
  version: number
  created_at: string
  updated_at: string
  completed_at: string | null
  source_status?: string | null
  source_record_id?: string | null
  source_cells?: Record<string, unknown>
}

export interface CloudLoopItemExecution {
  id: number
  loop_item_id: string
  cloud_project_id: string
  task_title: string
  task_status?: string | null
  task_priority?: string | null
  executor_type: 'project_robot' | 'automation_manager' | 'wegent_team' | string
  agent_id: string | null
  team_id?: number | null
  backend_task_id?: number | null
  automation_run_id: string
  executor_owner_user_id?: number | null
  assigner_user_id: number
  execution_environment: string
  execution_device_id?: string | null
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
  error_message?: string | null
  execution_note?: string | null
  approval_status?: string | null
  approved_by_user_id?: number | null
  rejected_reason?: string | null
  runtime_device_id?: string | null
  runtime_task_id?: string | null
  runtime_profile_id?: string | null
  runtime_source?: string | null
  can_select_runtime?: boolean
  waiting_runtime_reason?: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface CloudLoopItemAttachment {
  id: string
  loop_item_id: string
  display_name: string
  content_type: string | null
  size_bytes: number
  sha256: string
  created_by_user_id: number
  created_at: string
  markdown_url: string
  markdown: string
}

export interface ProjectTaskAttachment extends CloudLoopItemAttachment {
  loop_item_title: string
}

export interface CloudProject {
  id: CloudProjectId
  public_id: string
  project_key: string
  name: string
  description: string
  project_store: 'local' | 'backend'
  // Cloud responses can contain provider kinds introduced by a newer backend.
  task_provider: string
  provider_config: {
    repository?: string
    domain?: string
    api_base?: string
    credential_configured?: boolean
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
  card_display?: {
    show_assignee: boolean
    show_priority: boolean
    show_tags: boolean
    show_date: boolean
  }
  board_config?: {
    group_by: 'status' | 'priority' | 'assignee' | 'tag'
    processing_start_status_id: string | null
    statuses: Array<{
      id: string
      name: string
      color: 'gray' | 'blue' | 'orange' | 'purple' | 'green' | 'red'
    }>
  }
  ai_automation?: {
    auto_retry_on_failure: boolean
    max_retry_count: number
  }
  pull_request_automation?: {
    enabled: boolean
    statuses: PullRequestAutoRepairStatus[]
    prompt: string
  }
  workflow_definition?: ProjectWorkflowDefinition
  workflow_automation_id?: string | null
  created_by_user_id: number
  current_user_id?: number
  current_user_name?: string
  access_role?: 'Owner' | 'Maintainer' | 'Developer' | 'Reporter' | 'RestrictedAnalyst'
  visibility?: 'private' | 'public'
  status: string
  tags: string[]
  version: number
  created_at: string
  updated_at: string
  metadata?: {
    system_kind?: string
    [key: string]: unknown
  }
}

export type PullRequestAutoRepairStatus =
  | 'checks_failed'
  | 'merge_conflict'
  | 'merge_queue_failed'
  | 'merge_queue_timed_out'
  | 'merge_queue_conflicting'

export interface CloudTaskContext {
  id: string
  cloud_project_id: CloudProjectId
  loop_item_id: string | null
  task_user_id: number
  device_id: string
  task_id: string
  task_title: string | null
  backend_task_id: number | null
  workflow_node_id?: string | null
  project: CloudProject
  loop_item: CloudLoopItem | null
  linked_at: string
}

export type WorkflowWorkspacePolicy = 'none' | 'composer' | 'inherit'
export type WorkflowContextSource = 'final_result' | 'deliveries' | 'activity'
export type WorkflowNodeStatus =
  | 'blocked'
  | 'ready'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_deliverables'
  | 'changes_requested'
  | 'completed'
  | 'forced_completed'
  | 'failed'
export type IssueAdvancementPolicy = 'manual' | 'ai'
export type IssueStageMode = 'none' | 'dag'

export interface WorkflowExecutionConfig {
  agent_id: string | null
  runtime_profile_id: string | null
  execution_device_id: string | null
  model: string | null
  model_type: ModelType | null
  model_options: Record<string, string>
  workspace_binding: ProjectChatWorkspaceBindingInput | null
  runtime_permission_mode?: RuntimeTaskCreateRequest['runtimePermissionMode'] | null
  execution?: RuntimeTaskCreateRequest['execution'] | null
  initial_goal?: RuntimeGoalCreateInput | null
  initial_supervisor?: RuntimeSupervisorCreateInput | null
  additional_skills?: SkillRef[] | null
  attachment_ids?: number[] | null
  attachments?: Attachment[] | null
  project_plugins?: RuntimeProjectPluginRef[] | null
  additional_context?: RuntimeAdditionalContext | null
  ephemeral?: boolean | null
}

export interface WorkflowNodeDefinition {
  id: string
  name: string
  prompt?: string
  kind?: 'my_task' | 'automation' | 'ai' | null
  execution_mode?: 'human' | 'robot'
  depends_on: string[]
  dependency_context?: Record<string, WorkflowContextSource[]>
  required: boolean
  required_deliverables?: DeliverableRequirement[]
  workspace_policy: WorkflowWorkspacePolicy
  automation_rule_id?: string | null
  execution_config?: WorkflowExecutionConfig | null
  execution_config_override?: boolean
}

export interface ProjectWorkflowDefinition {
  version: number
  stage_mode?: IssueStageMode
  advancement_policy?: IssueAdvancementPolicy
  coordinator_prompt?: string
  approval_policy?: 'required' | 'automatic'
  ai_automation_rule_id?: string | null
  execution_config?: WorkflowExecutionConfig | null
  nodes: WorkflowNodeDefinition[]
}

export interface WorkflowNodeInstance extends WorkflowNodeDefinition {
  status: WorkflowNodeStatus
  task_binding_id?: string | null
  task_ids?: string[]
  task_statuses?: Record<string, string>
  delivery_ids?: string[]
  fulfilled_deliverable_ids?: string[]
  decision_history?: Array<{
    action: 'approve' | 'reject' | 'force_advance'
    actor_user_id: number
    reason: string
    decided_at: string
  }>
  execution_id?: number | null
  automation_run_id?: string | null
  execution_error?: string | null
}

export interface IssueWorkflowInstance {
  version: number
  definition_version: number
  stage_mode?: IssueStageMode
  advancement_policy?: IssueAdvancementPolicy
  coordinator_prompt?: string
  approval_policy?: 'required' | 'automatic'
  ai_automation_rule_id?: string | null
  execution_config?: WorkflowExecutionConfig | null
  orchestration_status?:
    | 'idle'
    | 'planning'
    | 'awaiting_approval'
    | 'dispatching'
    | 'running'
    | 'awaiting_review'
    | 'paused'
    | 'completed'
    | 'failed'
  active_run_id?: string | null
  active_plan_version?: number | null
  current_stage_id?: string | null
  nodes: WorkflowNodeInstance[]
}

export type WorkflowPlanStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'dispatching'
  | 'running'
  | 'awaiting_review'
  | 'paused'
  | 'completed'
  | 'failed'

export interface WorkflowPlanItem {
  id: string
  client_key: string
  stage_id: string
  title: string
  description: string
  assignee_type: 'user' | 'agent' | 'team'
  assignee_id: string
  assignee_name: string
  rationale: string
  task_id?: string | null
  task_status?: CloudLoopItem['status'] | null
  outcome_verdict?: 'passed' | 'needs_rework' | null
  outcome_summary?: string
  status: 'proposed' | 'materialized' | 'superseded'
}

export interface WorkflowManagerRun {
  id: string
  status: string
  model?: string | null
  execution_environment?: string | null
  device_id?: string | null
  recent_activity: string
  error?: string | null
  updated_at: string
}

export interface WorkflowPlan {
  run_id: string
  issue_id: string
  stage_id: string
  plan_version: number
  approval_policy: 'required' | 'automatic'
  status: WorkflowPlanStatus
  summary: string
  items: WorkflowPlanItem[]
  manager_run?: WorkflowManagerRun | null
}

export interface CloudProjectFile {
  id: string
  cloud_project_id: CloudProjectId
  path: string
  name: string
  kind: 'file' | 'folder'
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

export interface ProjectDeliveryFile {
  asset_id: string
  delivery_id: string
  loop_item_id: string
  loop_item_title: string
  relative_path: string
  display_name: string
  content_type: string | null
  size_bytes: number
  delivered_at: string
  loop_item_path: Array<{
    id: string
    title: string
  }>
}

export interface CloudProjectMember {
  id: number
  user_id: number
  user_name: string
  email: string | null
  role: 'Owner' | 'Maintainer' | 'Developer' | 'Reporter'
  capability_description?: string
}

export interface LoopItemTaskBinding {
  id: number
  cloud_project_id?: string | number
  loop_item_id: string | null
  task_user_id: number
  device_id: string
  task_id: string
  task_title: string | null
  backend_task_id: number | null
  workflow_node_id?: string | null
  binding_type?: 'system' | 'user'
  linked_at: string
}

export interface LoopItemPage {
  items: CloudLoopItem[]
  task_bindings: LoopItemTaskBinding[]
  next_cursor: string | null
}

export interface ProjectBoardSnapshot {
  items: CloudLoopItem[]
  task_bindings: LoopItemTaskBinding[]
  members: CloudProjectMember[]
  agents: ProjectChatAgent[]
}

export interface CloudLoopItemCollaborator {
  id: string
  loop_item_id: string
  user_id: number
  user_name: string
  email: string | null
  source: 'manual' | 'task' | 'delivery' | string
  added_by_user_id: number
  created_at: string
}

export interface CloudUserSearchItem {
  id: number
  user_name: string
  email: string | null
}

export interface CloudMyWorkItem extends CloudLoopItem {
  project_key: string
  project_name: string
  has_active_task: boolean
}

export const DEFAULT_WORK_ITEM_PROJECT_KEY = 'WORK'
export const DEFAULT_WORK_ITEM_PROJECT_ID = 'default-work-items'

export type TaskExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'archived'

export function isDefaultWorkItemProject(project: CloudProject | null | undefined): boolean {
  return (
    String(project?.id) === DEFAULT_WORK_ITEM_PROJECT_ID &&
    project?.project_key === DEFAULT_WORK_ITEM_PROJECT_KEY &&
    (!project.metadata?.system_kind || project.metadata.system_kind === 'default_work_items')
  )
}

export function nextTaskTrackingStatus(
  itemStatus: CloudLoopItem['status'],
  executionStatus: TaskExecutionStatus
): CloudLoopItem['status'] | null {
  if (executionStatus === 'queued' && itemStatus !== 'pending') {
    return 'pending'
  }
  if (executionStatus === 'running' && itemStatus !== 'in_progress') {
    return 'in_progress'
  }
  if (executionStatus === 'succeeded' && itemStatus !== 'completed') {
    return 'in_review'
  }
  if (
    (executionStatus === 'failed' || executionStatus === 'cancelled') &&
    itemStatus !== 'completed' &&
    itemStatus !== 'in_review'
  ) {
    return 'in_review'
  }
  if (executionStatus === 'archived' && itemStatus !== 'completed') return 'completed'
  return null
}

function projectTaskTrackingKey(projectId: CloudProjectIdInput, task: RuntimeTaskAddress): string {
  return `${projectId}:${task.deviceId}:${task.taskId}`
}

function runtimeTaskTrackingKey(task: RuntimeTaskAddress): string {
  return `${task.deviceId}:${task.taskId}`
}

export function createProjectTaskTrackingSingleFlight() {
  const requests = new Map<string, Promise<{ item: CloudLoopItem }>>()

  return (
    projectId: CloudProjectIdInput,
    task: RuntimeTaskAddress,
    create: () => Promise<{ item: CloudLoopItem }>
  ): Promise<{ item: CloudLoopItem }> => {
    const key = projectTaskTrackingKey(projectId, task)
    const existing = requests.get(key)
    if (existing) return existing

    const request = create()
    requests.set(key, request)
    const clear = () => {
      if (requests.get(key) === request) requests.delete(key)
    }
    void request.then(clear, clear)
    return request
  }
}

export function createTaskTrackingStatusQueue() {
  const tails = new Map<string, Promise<void>>()

  return <T>(task: RuntimeTaskAddress, update: () => Promise<T>): Promise<T> => {
    const key = runtimeTaskTrackingKey(task)
    const previous = tails.get(key) ?? Promise.resolve()
    const request = previous.then(update, update)
    const tail = request.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return request
  }
}

export const enqueueTaskTrackingMutation = createTaskTrackingStatusQueue()

const workflowMutationTails = new Map<string, Promise<void>>()

export function enqueueIssueWorkflowMutation<T>(
  itemId: string,
  update: () => Promise<T>
): Promise<T> {
  const previous = workflowMutationTails.get(itemId) ?? Promise.resolve()
  const request = previous.then(update, update)
  const tail = request.then(
    () => undefined,
    () => undefined
  )
  workflowMutationTails.set(itemId, tail)
  void tail.then(() => {
    if (workflowMutationTails.get(itemId) === tail) workflowMutationTails.delete(itemId)
  })
  return request
}

export function createDeliveryApi(client: HttpClient) {
  const trackProjectTaskOnce = createProjectTaskTrackingSingleFlight()
  const pendingTrackedItems = new Map<string, CloudLoopItem>()

  const api = {
    listCloudProjects(): Promise<{ items: CloudProject[] }> {
      return client.get('/v1/cloud-projects')
    },
    createCloudProject(data: {
      project_key?: string
      name: string
      description?: string
      task_provider?: 'local' | 'github' | 'gitlab' | 'dingtalk_aitable'
      visibility?: 'private' | 'public'
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
    }): Promise<CloudProject> {
      return client.post('/v1/cloud-projects', data)
    },
    updateCloudProject(
      projectId: CloudProjectIdInput,
      data: {
        name?: string
        description?: string
        tags?: string[]
        visibility?: 'private' | 'public'
        card_display?: CloudProject['card_display']
        board_config?: CloudProject['board_config']
        pull_request_automation?: CloudProject['pull_request_automation']
        workflow_definition?: CloudProject['workflow_definition']
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
        version: number
      }
    ): Promise<CloudProject> {
      return client.patch(`/v1/cloud-projects/${projectId}`, data)
    },
    archiveCloudProject(projectId: CloudProjectIdInput, version: number): Promise<void> {
      return client.delete(`/v1/cloud-projects/${projectId}?version=${version}`)
    },
    listMyWork(): Promise<{ items: CloudMyWorkItem[] }> {
      return client.get('/v1/cloud-work-items/my-work')
    },
    listLoopItems(
      projectId: CloudProjectIdInput,
      filters?: {
        assigneeType?: 'user' | 'agent' | 'team'
        assigneeId?: string | number
        executionState?: string
      }
    ): Promise<{ items: CloudLoopItem[] }> {
      const query = new URLSearchParams()
      if (filters?.assigneeType) query.set('assignee_type', filters.assigneeType)
      if (filters?.assigneeId !== undefined && filters.assigneeId !== null) {
        query.set('assignee_id', String(filters.assigneeId))
      }
      if (filters?.executionState) query.set('execution_state', filters.executionState)
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return client.get(`/v1/cloud-projects/${projectId}/loop-items${suffix}`)
    },
    listLoopItemsPage(
      projectId: CloudProjectIdInput,
      options: {
        status: CloudLoopItem['status']
        parentId: string | null
        cursor?: string | null
        limit?: number
      }
    ): Promise<LoopItemPage> {
      const query = new URLSearchParams({
        status: options.status,
        limit: String(options.limit ?? 10),
      })
      if (options.parentId) query.set('parent_id', options.parentId)
      if (options.cursor) query.set('cursor', options.cursor)
      return client.get(`/v1/cloud-projects/${projectId}/loop-item-pages?${query.toString()}`)
    },
    getBoardSnapshot(projectId: CloudProjectIdInput): Promise<ProjectBoardSnapshot> {
      return client.get(`/v1/cloud-projects/${projectId}/board-snapshot`)
    },
    listLoopItemExecutions(
      projectId: CloudProjectIdInput,
      options: { agent_id?: string; status?: string } = {}
    ): Promise<{ items: CloudLoopItemExecution[] }> {
      const query = new URLSearchParams()
      if (options.agent_id) query.set('agent_id', options.agent_id)
      if (options.status) query.set('status', options.status)
      const suffix = query.toString() ? `?${query.toString()}` : ''
      return client
        .get<{
          items: Array<Record<string, unknown>>
        }>(`/v1/cloud-projects/${projectId}/executions${suffix}`)
        .then(response => ({
          items: response.items.map(row => ({
            id: Number(row.id),
            loop_item_id: String(row.loopItemId ?? ''),
            cloud_project_id: String(row.cloudProjectId ?? ''),
            task_title: String(row.taskTitle ?? ''),
            task_status: row.taskStatus == null ? null : String(row.taskStatus),
            task_priority: row.taskPriority == null ? null : String(row.taskPriority),
            executor_type: String(row.executorType ?? 'project_robot'),
            agent_id: row.agentId == null ? null : String(row.agentId),
            team_id: row.teamId == null ? null : Number(row.teamId),
            backend_task_id: row.backendTaskId == null ? null : Number(row.backendTaskId),
            automation_run_id: String(row.automationRunId ?? ''),
            executor_owner_user_id:
              row.executorOwnerUserId == null ? null : Number(row.executorOwnerUserId),
            assigner_user_id: Number(row.assignerUserId ?? 0),
            execution_environment: String(row.executionEnvironment ?? ''),
            execution_device_id:
              row.executionDeviceId == null ? null : String(row.executionDeviceId),
            status: String(row.status ?? ''),
            display_state: String(row.displayState ?? 'unknown'),
            observed_state: String(row.observedState ?? 'unconfirmed'),
            sync_state: String(row.syncState ?? 'pending'),
            priority_weight: Number(row.priorityWeight ?? 0),
            queued_at: row.queuedAt == null ? null : String(row.queuedAt),
            started_at: row.startedAt == null ? null : String(row.startedAt),
            completed_at: row.completedAt == null ? null : String(row.completedAt),
            lease_expires_at: row.leaseExpiresAt == null ? null : String(row.leaseExpiresAt),
            heartbeat_at: row.heartbeatAt == null ? null : String(row.heartbeatAt),
            claimed_at: row.claimedAt == null ? null : String(row.claimedAt),
            start_requested_at: row.startRequestedAt == null ? null : String(row.startRequestedAt),
            observed_at: row.observedAt == null ? null : String(row.observedAt),
            cancel_requested_at:
              row.cancelRequestedAt == null ? null : String(row.cancelRequestedAt),
            attempt_no: Number(row.attemptNo ?? 1),
            previous_execution_id:
              row.previousExecutionId == null ? null : Number(row.previousExecutionId),
            execution_scope: String(row.executionScope ?? ''),
            last_event_seq: Number(row.lastEventSeq ?? 0),
            termination_reason: String(row.terminationReason ?? ''),
            retry_attempt: Number(row.retryAttempt ?? 0),
            error_message: row.errorMessage == null ? null : String(row.errorMessage),
            execution_note: row.executionNote == null ? null : String(row.executionNote),
            approval_status: row.approvalStatus == null ? null : String(row.approvalStatus),
            approved_by_user_id: row.approvedByUserId == null ? null : Number(row.approvedByUserId),
            rejected_reason: row.rejectedReason == null ? null : String(row.rejectedReason),
            runtime_device_id: row.runtimeDeviceId == null ? null : String(row.runtimeDeviceId),
            runtime_task_id: row.runtimeTaskId == null ? null : String(row.runtimeTaskId),
            runtime_profile_id: row.runtimeProfileId == null ? null : String(row.runtimeProfileId),
            runtime_source: row.runtimeSource == null ? null : String(row.runtimeSource),
            can_select_runtime: row.canSelectRuntime === true,
            waiting_runtime_reason:
              row.waitingRuntimeReason == null ? null : String(row.waitingRuntimeReason),
            version: Number(row.version ?? 1),
            created_at: String(row.createdAt ?? ''),
            updated_at: String(row.updatedAt ?? ''),
          })),
        }))
    },
    stopExecution(
      projectId: CloudProjectIdInput,
      executionId: number
    ): Promise<{ id: number; status: string }> {
      return client.post(`/v1/cloud-projects/${projectId}/executions/${executionId}/stop`)
    },
    getLoopItem(itemId: string): Promise<CloudLoopItem> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}`)
    },
    getWorkflowPlan(itemId: string): Promise<WorkflowPlan | null> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/workflow-plan`)
    },
    approveWorkflowPlan(itemId: string): Promise<WorkflowPlan> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/workflow-plan/approve`, {})
    },
    approveWorkflowReview(itemId: string): Promise<WorkflowPlan> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/workflow-plan/review`, {})
    },
    pauseWorkflowPlan(itemId: string): Promise<WorkflowPlan> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/workflow-plan/pause`, {})
    },
    resumeWorkflowPlan(itemId: string): Promise<WorkflowPlan> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/workflow-plan/resume`, {})
    },
    replanWorkflowPlan(itemId: string): Promise<WorkflowPlan> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/workflow-plan/replan`, {})
    },
    markLoopItemRead(itemId: string): Promise<CloudLoopItem> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/read`)
    },
    findLoopItemForTask(task: RuntimeTaskAddress): Promise<CloudLoopItem> {
      const query = new URLSearchParams({ device_id: task.deviceId, task_id: task.taskId })
      return client.get(`/v1/runtime-tasks/loop-item?${query.toString()}`)
    },
    findCloudContextForTask(task: RuntimeTaskAddress): Promise<CloudTaskContext> {
      const query = new URLSearchParams({ device_id: task.deviceId, task_id: task.taskId })
      return client.get(`/v1/runtime-tasks/cloud-context?${query.toString()}`)
    },
    createLoopItem(
      projectId: CloudProjectIdInput,
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
        workflow?: IssueWorkflowInstance | null
        execution_config?: WorkflowExecutionConfig | null
        automation_rule_id?: string | null
      }
    ): Promise<CloudLoopItem> {
      return client.post(`/v1/cloud-projects/${projectId}/loop-items`, data)
    },
    updateLoopItem(
      itemId: string,
      data: Partial<
        Pick<
          CloudLoopItem,
          | 'title'
          | 'description'
          | 'status'
          | 'priority'
          | 'parent_id'
          | 'assignee_user_id'
          | 'assignee_agent_id'
          | 'assignee_team_id'
          | 'due_at'
          | 'tags'
          | 'workflow'
          | 'execution_config'
        >
      > & {
        version: number
        automation_rule_id?: string | null
      }
    ): Promise<CloudLoopItem> {
      return client.patch(`/v1/loop-items/${encodeURIComponent(itemId)}`, data)
    },
    assignLoopItem(
      projectId: CloudProjectIdInput,
      itemId: string,
      data: {
        version: number
        assigneeType: 'user' | 'agent' | 'team'
        assigneeId: string
      }
    ): Promise<CloudLoopItem> {
      return client.post(
        `/v1/cloud-projects/${projectId}/loop-items/${encodeURIComponent(itemId)}/assign`,
        data
      )
    },
    approveLoopItemRun(
      projectId: CloudProjectIdInput,
      itemId: string,
      version: number
    ): Promise<CloudLoopItem> {
      return client.post(
        `/v1/cloud-projects/${projectId}/loop-items/${encodeURIComponent(itemId)}/approve`,
        { version }
      )
    },
    rejectLoopItemRun(
      projectId: CloudProjectIdInput,
      itemId: string,
      version: number,
      reason?: string
    ): Promise<CloudLoopItem> {
      return client.post(
        `/v1/cloud-projects/${projectId}/loop-items/${encodeURIComponent(itemId)}/reject`,
        { version, reason: reason ?? null }
      )
    },
    archiveLoopItem(itemId: string): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(itemId)}`)
    },
    reorderLoopItems(
      projectId: CloudProjectIdInput,
      data: {
        parent_id: string | null
        status: string
        item_ids: string[]
      }
    ): Promise<{ items: CloudLoopItem[] }> {
      return client.post(`/v1/cloud-projects/${projectId}/loop-items/reorder`, data)
    },
    listLoopItemAttachments(itemId: string): Promise<CloudLoopItemAttachment[]> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/attachments`)
    },
    listProjectTaskAttachments(
      projectId: CloudProjectIdInput
    ): Promise<{ items: ProjectTaskAttachment[] }> {
      return client.get(`/v1/cloud-projects/${projectId}/task-attachments`)
    },
    importLoopItemAttachments(
      itemId: string,
      attachments: Attachment[]
    ): Promise<CloudLoopItemAttachment[]> {
      return client.post(
        `/v1/loop-items/${encodeURIComponent(itemId)}/attachments/import-contexts`,
        {
          context_ids: attachments
            .filter(attachment => attachment.id > 0)
            .map(attachment => attachment.id),
        }
      )
    },
    addLoopItemAttachment(itemId: string, file: File): Promise<CloudLoopItemAttachment> {
      const form = new FormData()
      form.set('file', file, file.name)
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/attachments`, form)
    },
    accessLoopItemAttachment(
      attachmentId: string
    ): Promise<{ url: string; expires_in_seconds: number }> {
      return client.get(`/v1/loop-item-attachments/${attachmentId}/access`)
    },
    readLoopItemAttachment(attachmentId: string): Promise<Blob> {
      return client.getBlob(`/v1/loop-item-attachments/${attachmentId}/content`)
    },
    async downloadLoopItemAttachment(attachmentId: string, filename: string): Promise<void> {
      const content = await client.getBlob(`/v1/loop-item-attachments/${attachmentId}/content`)
      await saveBlobToDownloads(content, filename)
    },
    deleteLoopItemAttachment(attachmentId: string): Promise<void> {
      return client.delete(`/v1/loop-item-attachments/${attachmentId}`)
    },
    listTaskBindings(itemId: string): Promise<LoopItemTaskBinding[]> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`)
    },
    listLoopItemCollaborators(itemId: string): Promise<CloudLoopItemCollaborator[]> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/collaborators`)
    },
    addLoopItemCollaborator(itemId: string, userId: number): Promise<CloudLoopItemCollaborator> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/collaborators`, {
        user_id: userId,
      })
    },
    removeLoopItemCollaborator(itemId: string, userId: number): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(itemId)}/collaborators/${userId}`)
    },
    bindTask(
      itemId: string,
      task: RuntimeTaskAddress,
      taskTitle?: string | null,
      workflowNodeId?: string | null
    ): Promise<void> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`, {
        ...task,
        ...(taskTitle ? { taskTitle } : {}),
        ...(workflowNodeId ? { workflowNodeId } : {}),
      })
    },
    decideWorkflowNode(
      itemId: string,
      workflowNodeId: string,
      action: 'approve' | 'reject' | 'force_advance',
      reason = '',
      actorUserId?: number
    ): Promise<CloudLoopItem> {
      void actorUserId
      return client.post(
        `/v1/loop-items/${encodeURIComponent(itemId)}/workflow-nodes/${encodeURIComponent(workflowNodeId)}/decision`,
        { action, reason }
      )
    },
    trackProjectTask(
      projectId: CloudProjectIdInput,
      task: RuntimeTaskAddress,
      taskTitle: string,
      description: string
    ): Promise<{ item: CloudLoopItem }> {
      return trackProjectTaskOnce(projectId, task, async () => {
        const trackingKey = projectTaskTrackingKey(projectId, task)
        try {
          const existing = await api.findCloudContextForTask(task)
          if (existing.loop_item_id && String(existing.project.id) === String(projectId)) {
            pendingTrackedItems.delete(trackingKey)
            return { item: await api.getLoopItem(existing.loop_item_id) }
          }
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error
        }

        const item =
          pendingTrackedItems.get(trackingKey) ??
          (await api.createLoopItem(projectId, {
            title: taskTitle,
            description,
            status: String(projectId) === DEFAULT_WORK_ITEM_PROJECT_ID ? 'inbox' : 'pending',
          }))
        pendingTrackedItems.set(trackingKey, item)
        await api.bindTask(item.id, task, taskTitle)
        pendingTrackedItems.delete(trackingKey)
        return { item }
      })
    },
    async updateTaskTrackingStatus(
      task: RuntimeTaskAddress,
      executionStatus: TaskExecutionStatus
    ): Promise<CloudLoopItem | null> {
      return enqueueTaskTrackingMutation(task, async () => {
        console.info('[IssueTaskStatusSync] status update requested', {
          deviceId: task.deviceId,
          taskId: task.taskId,
          executionStatus,
        })
        let context: CloudTaskContext
        try {
          context = await api.findCloudContextForTask(task)
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            console.warn('[IssueTaskStatusSync] task binding not found', {
              deviceId: task.deviceId,
              taskId: task.taskId,
              executionStatus,
            })
            return null
          }
          throw error
        }
        console.info('[IssueTaskStatusSync] task binding resolved', {
          deviceId: task.deviceId,
          taskId: task.taskId,
          executionStatus,
          loopItemId: context.loop_item_id,
          workflowNodeId: context.workflow_node_id,
        })
        if (!context.loop_item_id) return null
        const item = context.loop_item ?? (await api.getLoopItem(context.loop_item_id))
        if (item.workflow && context.workflow_node_id) return item
        if (item.execution_id != null) return item
        if (executionStatus === 'succeeded') {
          const bindings = await api.listTaskBindings(item.id)
          if (bindings.length > 1) return item
        }
        const nextStatus = nextTaskTrackingStatus(item.status, executionStatus)
        return nextStatus
          ? api.updateLoopItem(item.id, {
              version: item.version,
              status: nextStatus,
            })
          : item
      })
    },
    async updateTaskTrackingTitle(
      task: RuntimeTaskAddress,
      title: string
    ): Promise<CloudLoopItem | null> {
      return enqueueTaskTrackingMutation(task, async () => {
        let context: CloudTaskContext
        try {
          context = await api.findCloudContextForTask(task)
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null
          throw error
        }
        if (!context.loop_item_id) return null
        const item = await api.getLoopItem(context.loop_item_id)
        return item.title === title
          ? item
          : api.updateLoopItem(item.id, {
              version: item.version,
              title,
            })
      })
    },
    unbindCloudContext(task: RuntimeTaskAddress): Promise<void> {
      return client.delete('/v1/runtime-tasks/cloud-context', task)
    },
    unbindTask(itemId: string, task: RuntimeTaskAddress): Promise<void> {
      return client.delete(`/v1/loop-items/${encodeURIComponent(itemId)}/tasks`, task)
    },
    listCloudProjectMembers(projectId: CloudProjectIdInput): Promise<CloudProjectMember[]> {
      return client.get(`/v1/cloud-projects/${projectId}/members`)
    },
    addCloudProjectMember(
      projectId: CloudProjectIdInput,
      userId: number,
      role: CloudProjectMember['role'] = 'Developer'
    ): Promise<CloudProjectMember> {
      return client.post(`/v1/cloud-projects/${projectId}/members`, {
        user_id: userId,
        role,
      })
    },
    updateCloudProjectMember(
      projectId: CloudProjectIdInput,
      userId: number,
      values: {
        role?: Exclude<CloudProjectMember['role'], 'Owner'>
        capability_description?: string
      }
    ): Promise<CloudProjectMember> {
      return client.patch(`/v1/cloud-projects/${projectId}/members/${userId}`, values)
    },
    removeCloudProjectMember(projectId: CloudProjectIdInput, userId: number): Promise<void> {
      return client.delete(`/v1/cloud-projects/${projectId}/members/${userId}`)
    },
    searchCloudProjectUsers(
      query: string
    ): Promise<{ users: CloudUserSearchItem[]; total: number }> {
      return client.get(`/users/search?q=${encodeURIComponent(query)}&limit=20`)
    },
    listCloudFiles(projectId: CloudProjectIdInput): Promise<{ items: CloudProjectFile[] }> {
      return client.get(`/v1/cloud-projects/${projectId}/files`)
    },
    listProjectDeliveryFiles(
      projectId: CloudProjectIdInput
    ): Promise<{ items: ProjectDeliveryFile[] }> {
      return client.get(`/v1/cloud-projects/${projectId}/delivery-files`)
    },
    createCloudFolder(projectId: CloudProjectIdInput, path: string): Promise<CloudProjectFile> {
      return client.post(`/v1/cloud-projects/${projectId}/folders`, { path })
    },
    uploadCloudFile(
      projectId: CloudProjectIdInput,
      file: File,
      path = file.name
    ): Promise<CloudProjectFile> {
      const form = new FormData()
      form.set('file', file, file.name)
      form.set('path', path)
      return client.post(`/v1/cloud-projects/${projectId}/files`, form)
    },
    accessCloudFile(fileId: string): Promise<{ url: string; expires_in_seconds: number }> {
      return client.get(`/v1/cloud-projects/files/${fileId}/access`)
    },
    readCloudFile(fileId: string): Promise<Blob> {
      return client.getBlob(`/v1/cloud-projects/files/${fileId}/content`)
    },
    accessDeliveryFile(assetId: string): Promise<{ url: string; expires_in_seconds: number }> {
      return client.get(`/v1/delivery-assets/${encodeURIComponent(assetId)}/access`)
    },
    readDeliveryFile(assetId: string): Promise<Blob> {
      return client.getBlob(`/v1/delivery-assets/${encodeURIComponent(assetId)}/content`)
    },
    moveCloudFile(fileId: string, path: string, version: number): Promise<CloudProjectFile> {
      return client.patch(`/v1/cloud-projects/files/${fileId}`, { path, version })
    },
    deleteCloudFile(fileId: string, recursive = false): Promise<void> {
      return client.delete(
        `/v1/cloud-projects/files/${fileId}${recursive ? '?recursive=true' : ''}`
      )
    },
    createDelivery(itemId: string, data: DeliveryCreateInput): Promise<Delivery> {
      return client.post(`/v1/loop-items/${encodeURIComponent(itemId)}/deliveries`, data)
    },
    addAsset(deliveryId: string, file: File, relativePath: string): Promise<DeliveryAsset> {
      const form = new FormData()
      form.set('file', file, file.name)
      form.set('relative_path', relativePath)
      return client.post(`/v1/deliveries/${deliveryId}/assets`, form)
    },
    finalizeDelivery(
      deliveryId: string,
      data: DeliveryFinalizeInput = { fulfillments: [] }
    ): Promise<Delivery> {
      return client.post(`/v1/deliveries/${deliveryId}/finalize`, data)
    },
    getWorkflowStageContext(
      itemId: string,
      workflowNodeId: string
    ): Promise<Record<string, unknown> & { compiled_task_instruction: string }> {
      return client.get(
        `/v1/loop-items/${encodeURIComponent(itemId)}/workflow-nodes/${encodeURIComponent(
          workflowNodeId
        )}/input-context`
      )
    },
    discardDraft(deliveryId: string): Promise<void> {
      return client.delete(`/v1/deliveries/${deliveryId}`)
    },
    listDeliveries(itemId: string): Promise<{ items: Delivery[] }> {
      return client.get(`/v1/loop-items/${encodeURIComponent(itemId)}/deliveries`)
    },
    getDelivery(deliveryId: string): Promise<DeliveryDetail> {
      return client.get(`/v1/deliveries/${deliveryId}`)
    },
  }
  return api
}
