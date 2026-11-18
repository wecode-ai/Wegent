export type AutomationRunStatus =
  | "pending"
  | "queued"
  | "waiting_runtime"
  | "waiting_device"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type AutomationEventType =
  | "task.created"
  | "task.tag_added"
  | "task.status_changed"
  | "change_request.checks_failed"
  | "change_request.merge_conflict"
  | "change_request.review_submitted"
  | "change_request.comment_created"
  | "document.changed";

export type AutomationEventSourceType =
  | "github"
  | "gitlab"
  | "wework"
  | "generic";
export type AutomationEventCollectionMode =
  | "webhook"
  | "poll"
  | "internal"
  | "hybrid";
export type WorkflowContextSource = "final_result" | "deliveries" | "activity";
export type AutomationTargetKind = "human" | "agent" | "collaboration_group";

export interface AutomationEventConfig extends Record<string, unknown> {
  collectionMode?: unknown;
  collection_mode?: unknown;
  poll_interval_seconds?: unknown;
  repositories?: unknown;
  runtime_workflow_definition?: unknown;
  sourceType?: unknown;
  source_type?: unknown;
  subscriptionId?: unknown;
  subscription_id?: unknown;
  tags?: unknown;
  targetBranches?: unknown;
  target_branches?: unknown;
}

export interface AutomationBackendRule {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  triggerType: "manual" | "schedule" | "event" | "workflow";
  eventType: AutomationEventType | null;
  eventConfig: AutomationEventConfig;
  cronExpression: string | null;
  workdayOnly?: boolean;
  timezone: string;
  runnerSelection?: import("../agent-form/runnerRouting").RunnerSelection;
  executionDeviceId: string | null;
  targetKind: AutomationTargetKind;
  targetId: string;
  targetName: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationBackendRun {
  id: string;
  automationId: string;
  projectId: string;
  trigger: "scheduled" | "manual" | "event";
  status: AutomationRunStatus;
  timezone: string;
  scheduledFor: string;
  expiresAt: string | null;
  taskId: string | null;
  taskTitle?: string | null;
  backendTaskId: number | null;
  deviceId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  retryable?: boolean;
  triggerType?: "schedule" | "event" | "workflow" | null;
  eventType?: AutomationEventType | null;
  eventConfig?: AutomationEventConfig | null;
}

export interface WorkflowExecutionConfig {
  agent_id: string | null;
  runtime_profile_id: string | null;
  execution_device_id: string | null;
  model: string | null;
  model_type: "public" | "user" | "group" | "runtime" | null;
  model_options: Record<string, string>;
  workspace_binding: WorkflowWorkspaceBindingInput | null;
  runtime_permission_mode?: unknown;
  execution?: unknown;
  initial_goal?: unknown;
  initial_supervisor?: unknown;
  additional_skills?: unknown[] | null;
  attachment_ids?: number[] | null;
  attachments?: unknown[] | null;
  project_plugins?: WorkflowProjectPluginRef[] | null;
  additional_context?: unknown;
  ephemeral?: boolean | null;
}

export type WorkflowWorkspaceBindingInput =
  | {
      type: "backend_project";
      projectId: number;
      deviceWorkspaceId?: number | null;
      deviceId?: string | null;
    }
  | {
      type: "device_project";
      deviceId: string;
      runtimeProjectKey: string;
    }
  | {
      type: "standalone";
    };

export interface WorkflowProjectPluginRef {
  id: string;
  pluginName: string;
  marketplaceId: string;
  displayName: string;
  description?: string;
  catalogSource?: "cloud" | "local" | "local_cloud";
}

export interface WorkflowDeliverableRequirement {
  id: string;
  name: string;
  description: string;
  value_type:
    | "text"
    | "file"
    | "code_snapshot"
    | "git_branch"
    | "pull_request"
    | "url";
  accepted_value_types?: WorkflowDeliverableRequirement['value_type'][]
  pull_request_state?: 'merged' | null
  file_constraints?: {
    accepted_types: string[];
    min_files: number;
    max_files: number;
  } | null;
}

export interface WorkflowNodeDefinition {
  id: string;
  name: string;
  prompt?: string;
  kind?: "my_task" | "automation" | "ai" | null;
  node_type?: "task" | "event" | "loop" | "loop_start" | "branch" | "loop_end";
  role?: "start" | null;
  start_config?: {
    trigger_type?: "schedule" | "event" | "workflow";
    event_type?: string | null;
    cron_expression?: string | null;
    source_type?: string | null;
  } | null;
  loop_id?: string | null;
  body_node_ids?: string[];
  loop_config?: {
    max_attempts?: number;
    timeout_seconds?: number | null;
  } | null;
  branch_conditions?: Array<{
    source_type: "github" | "gitlab";
    event_type: string;
    handler_node_ids: string[];
    subscription_id?: string | null;
    collection_mode?: string | null;
  }>;
  event_wait?: {
    subject_source: "upstream_pull_request";
    collection_mode: "webhook" | "poll";
    subscription_id?: string | null;
    poll_interval_seconds?: number | null;
  } | null;
  execution_mode?: "human" | "robot";
  depends_on: string[];
  dependency_context?: Record<string, WorkflowContextSource[]>;
  required: boolean;
  required_deliverables?: WorkflowDeliverableRequirement[];
  workspace_policy: "none" | "composer" | "inherit";
  automation_rule_id?: string | null;
  required_assignee_type?: "user" | "agent" | "team" | null;
  required_assignee_id?: string | null;
  execution_config?: WorkflowExecutionConfig | null;
  execution_config_override?: boolean;
  rework_to?: string | null
  human_approval_required?: boolean
  functional_role?: string
}

export interface ProjectWorkflowDefinition {
  version: number;
  stage_mode?: "none" | "dag";
  advancement_policy?: "manual" | "ai";
  coordinator_prompt?: string;
  approval_policy?: "required" | "automatic";
  ai_automation_rule_id?: string | null;
  execution_config?: WorkflowExecutionConfig | null;
  nodes: WorkflowNodeDefinition[];
}

export interface WorkflowNodeDecision {
  action: 'approve' | 'reject' | 'force_advance'
  actor_user_id: number
  reason: string
  decided_at: string
  source?: 'human' | 'assistant'
  stage_durations_seconds?: Record<string, number>
}

export interface WorkflowNodeInstance extends WorkflowNodeDefinition {
  status: string
  attempts: number
  delivery_ids: string[]
  decision_history: WorkflowNodeDecision[]
  activated_at?: string | null
  deliverables_completed_at?: string | null
  execution_error?: string | null
}

export interface IssueWorkflowInstance extends Omit<ProjectWorkflowDefinition, 'nodes'> {
  instance_id?: string | null
  definition_version: number
  nodes: WorkflowNodeInstance[]
  current_stage_id?: string | null
  strategy_snapshot?: CollaborationStrategyRevision | null
  strategy_state?: 'inbox' | 'active' | null
  coordinator_decision?: StrategyCoordinatorDecision | null
  strategy_upgrade_history?: Array<{
    from_version: number
    to_version: number
    reason: string
    migration_impact: { preserved_stage_ids: string[]; preserved_evidence: boolean; role_mapping_changed: boolean }
    actor_user_id: number
    upgraded_at: string
  }>
}

export type StrategyFunctionalRole = 'product' | 'development' | 'design' | 'qa' | 'pmo'
export type StrategyRoleMapping = Record<StrategyFunctionalRole, string[]>

export interface CollaborationStrategyUpdate {
  text: string
  expected_version: number
}

export interface CollaborationStrategyRevision extends Omit<CollaborationStrategyUpdate, 'expected_version'> {
  role_mapping: StrategyRoleMapping
  version: number
  diff: string
  published_at: string
  published_by: number
  source_path: string
}

export interface IssueIntakeDefinition {
  objective: string
  scope: string
  non_goals: string
  acceptance_criteria: string
  dependencies: string
  proposed_owner: string
}

export interface StrategyCoordinatorDecision {
  confidence?: number | null
  evidence_conflict?: boolean
  strategy_version: number
  issue_version: number
  stage: string
  next_owner: string | null
  next_action: string
  satisfied_conditions: string[]
  missing_conditions: string[]
  evidence_refs: string[]
  clarification: string | null
  idempotency_key: string
  integration_status?: 'pending_w0056' | 'recorded'
}

export type IssueWorkflowAction =
  | { type: 'apply_project'; reason?: string; idempotency_key?: string }
  | { type: 'admit' | 'evaluate'; idempotency_key: string }
  | { type: 'upgrade_strategy'; reason: string; idempotency_key: string }
  | { type: 'record_coordinator_decision'; decision: StrategyCoordinatorDecision; idempotency_key: string }
  | { type: 'set_stage_state'; node_id: string; state: 'waiting' | 'blocked' | 'ready'; reason: string; idempotency_key: string }
  | {
      type: 'decide_node'
      node_id: string
      action: 'approve' | 'reject' | 'force_advance'
      reason?: string
      idempotency_key: string
      rework_to?: 'development_preparation' | 'development_implementation'
    }

export interface AutomationProject {
  id: string | number;
  name: string;
  version: number;
  tags: string[];
  updated_at: string;
  workflow_automation_id?: string | null;
  workflow_definition?: ProjectWorkflowDefinition;
  current_user_id?: number;
}

export interface AutomationBackendInput {
  name: string;
  prompt: string;
  triggerType: "manual" | "schedule" | "event" | "workflow";
  eventType: AutomationEventType | null;
  eventConfig: Record<string, unknown>;
  cronExpression: string | null;
  workdayOnly?: boolean;
  timezone: string;
  runnerSelection?: import("../agent-form/runnerRouting").RunnerSelection;
  executionDeviceId: string | null;
  targetKind: AutomationTargetKind;
  targetId: string;
  enabled: boolean;
}

export interface AutomationEventSourceCatalogItem {
  sourceType: AutomationEventSourceType;
  collectionModes: AutomationEventCollectionMode[];
  resourceTypes: string[];
  eventTypes: string[];
  executionTargets: Array<
    "existing_issue" | "continue_binding" | "create_issue"
  >;
  nameKey: string;
  descriptionKey: string;
}
