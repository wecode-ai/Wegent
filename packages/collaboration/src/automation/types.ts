export type AutomationRunStatus =
  | 'pending'
  | 'queued'
  | 'waiting_runtime'
  | 'waiting_device'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type AutomationEventType =
  | 'task.created'
  | 'task.status_changed'
  | 'change_request.checks_failed'
  | 'change_request.merge_conflict'
  | 'change_request.review_submitted'
  | 'change_request.comment_created'
  | 'document.changed'

export type AutomationEventSourceType = 'github' | 'gitlab' | 'wework' | 'generic'
export type AutomationEventCollectionMode = 'webhook' | 'poll' | 'internal' | 'hybrid'
export type WorkflowContextSource = 'final_result' | 'deliveries' | 'activity'

export interface AutomationEventConfig extends Record<string, unknown> {
  collectionMode?: unknown
  collection_mode?: unknown
  poll_interval_seconds?: unknown
  repositories?: unknown
  runtime_workflow_definition?: unknown
  sourceType?: unknown
  source_type?: unknown
  subscriptionId?: unknown
  subscription_id?: unknown
  tags?: unknown
  targetBranches?: unknown
  target_branches?: unknown
}

export interface AutomationBackendRule {
  id: string
  projectId: string
  name: string
  prompt: string
  triggerType: 'schedule' | 'event' | 'workflow'
  eventType: AutomationEventType | null
  eventConfig: AutomationEventConfig
  cronExpression: string | null
  timezone: string
  assignmentMode: 'manual' | 'ai_managed'
  managerType: 'custom' | 'wegent' | null
  agentId: string | null
  wegentTeamId: number | null
  model: string | null
  agentName: string
  executionEnvironment: 'local' | 'cloud' | 'managed'
  executionDeviceId: string | null
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunStatus: AutomationRunStatus | null
  version: number
  createdAt: string
  updatedAt: string
  roleSource?: 'generic' | 'agent'
  runtimeSource?: 'agent_default' | 'fixed_profile' | 'issue_creator' | 'runtime_user'
  runtimeProfileId?: string | null
  runtimeUserId?: number | null
}

export interface AutomationBackendRun {
  id: string
  automationId: string
  projectId: string
  trigger: 'scheduled' | 'manual' | 'event'
  status: AutomationRunStatus
  timezone: string
  scheduledFor: string
  expiresAt: string | null
  taskId: string | null
  taskTitle?: string | null
  backendTaskId: number | null
  deviceId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  retryable?: boolean
}

export interface WorkflowExecutionConfig {
  agent_id: string | null
  runtime_profile_id: string | null
  execution_device_id: string | null
  model: string | null
  model_type: 'public' | 'user' | 'group' | 'runtime' | null
  model_options: Record<string, string>
  workspace_binding: WorkflowWorkspaceBindingInput | null
  runtime_permission_mode?: unknown
  execution?: unknown
  initial_goal?: unknown
  initial_supervisor?: unknown
  additional_skills?: unknown[] | null
  attachment_ids?: number[] | null
  attachments?: unknown[] | null
  project_plugins?: WorkflowProjectPluginRef[] | null
  additional_context?: unknown
  ephemeral?: boolean | null
}

export type WorkflowWorkspaceBindingInput =
  | {
      type: 'backend_project'
      projectId: number
      deviceWorkspaceId?: number | null
      deviceId?: string | null
    }
  | {
      type: 'device_project'
      deviceId: string
      runtimeProjectKey: string
    }
  | {
      type: 'standalone'
    }

export interface WorkflowProjectPluginRef {
  id: string
  pluginName: string
  marketplaceId: string
  displayName: string
}

export interface WorkflowDeliverableRequirement {
  id: string
  name: string
  description: string
  value_type: 'text' | 'file' | 'code_snapshot' | 'git_branch' | 'pull_request' | 'url'
  file_constraints?: {
    accepted_types: string[]
    min_files: number
    max_files: number
  } | null
}

export interface WorkflowNodeDefinition {
  id: string
  name: string
  prompt?: string
  kind?: 'my_task' | 'automation' | 'ai' | null
  node_type?: 'task' | 'event' | 'loop' | 'loop_start' | 'branch' | 'loop_end'
  role?: 'start' | null
  start_config?: {
    trigger_type?: 'schedule' | 'event' | 'workflow'
    event_type?: string | null
    cron_expression?: string | null
    source_type?: string | null
  } | null
  loop_id?: string | null
  body_node_ids?: string[]
  loop_config?: {
    max_attempts?: number
    timeout_seconds?: number | null
  } | null
  branch_conditions?: Array<{
    source_type: 'github' | 'gitlab'
    event_type: string
    handler_node_ids: string[]
    subscription_id?: string | null
    collection_mode?: string | null
  }>
  event_wait?: {
    subject_source: 'upstream_pull_request'
    collection_mode: 'webhook' | 'poll'
    subscription_id?: string | null
    poll_interval_seconds?: number | null
  } | null
  execution_mode?: 'human' | 'robot'
  depends_on: string[]
  dependency_context?: Record<string, WorkflowContextSource[]>
  required: boolean
  required_deliverables?: WorkflowDeliverableRequirement[]
  workspace_policy: 'none' | 'composer' | 'inherit'
  automation_rule_id?: string | null
  execution_config?: WorkflowExecutionConfig | null
  execution_config_override?: boolean
}

export interface ProjectWorkflowDefinition {
  version: number
  stage_mode?: 'none' | 'dag'
  advancement_policy?: 'manual' | 'ai'
  coordinator_prompt?: string
  approval_policy?: 'required' | 'automatic'
  ai_automation_rule_id?: string | null
  execution_config?: WorkflowExecutionConfig | null
  nodes: WorkflowNodeDefinition[]
}

export interface AutomationProject {
  id: string | number
  name: string
  version: number
  tags: string[]
  updated_at: string
  workflow_automation_id?: string | null
  workflow_definition?: ProjectWorkflowDefinition
  current_user_id?: number
}

export interface AutomationBackendInput {
  name: string
  prompt: string
  triggerType: 'schedule' | 'event' | 'workflow'
  eventType: AutomationEventType | null
  eventConfig: Record<string, unknown>
  cronExpression: string | null
  timezone: string
  assignmentMode: 'manual' | 'ai_managed'
  managerType: 'custom' | 'wegent' | null
  agentId: string | null
  wegentTeamId: number | null
  model: string | null
  executionEnvironment: 'local' | 'cloud' | null
  executionDeviceId: string | null
  enabled: boolean
  roleSource?: 'generic' | 'agent'
  runtimeSource?: 'agent_default' | 'fixed_profile' | 'issue_creator' | 'runtime_user'
  runtimeProfileId?: string | null
  runtimeUserId?: number | null
}

export interface AutomationEventSourceCatalogItem {
  sourceType: AutomationEventSourceType
  collectionModes: AutomationEventCollectionMode[]
  resourceTypes: string[]
  eventTypes: string[]
  executionTargets: Array<'existing_issue' | 'continue_binding' | 'create_issue'>
  nameKey: string
  descriptionKey: string
}
