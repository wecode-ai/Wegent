import type { HttpClient } from './http'

export type ExecutionActorType = 'project_agent' | 'project_squad' | 'wegent_team'
export type ExecutionTargetType = 'registered_device' | 'managed_container'
export type WorkspaceMode = 'current_workspace' | 'git_worktree'

export interface ExecutionActorRef {
  type: ExecutionActorType
  id?: string
  teamId?: number
  namespace?: string
  name?: string
  userId?: number
  version?: number
}

export interface ExecutionTargetRef {
  type: ExecutionTargetType
  id?: string
}

export interface ProjectAgentSquad {
  id: string
  projectId: string
  name: string
  leaderAgentId: string
  memberAgentIds: string[]
  routingInstructions: string
  maxParallelMembers: number
  status: 'active' | 'archived'
  createdByUserId: number
  version: number
  createdAt: string
  updatedAt: string
}

export interface RepositoryBinding {
  id: string
  projectId: string
  provider: 'github' | 'gitlab' | 'generic'
  repositoryIdentity: string
  repositoryUrl: string
  defaultBranch: string
  localProjectId: number | null
  defaultExecutionTarget: ExecutionTargetRef | null
  hasCredential: boolean
  webhookConfigured: boolean
  workspacePolicy: Record<string, unknown>
  gitPolicy: Record<string, unknown>
  providerSettings: Record<string, unknown>
  status: 'active' | 'archived'
  createdByUserId: number
  version: number
  createdAt: string
  updatedAt: string
}

export type WorkflowNodeType = 'agent' | 'human_gate' | 'ci_gate' | 'merge' | 'complete'

export interface WorkflowNode {
  key: string
  name: string
  type: WorkflowNodeType
  actor?: ExecutionActorRef
  promptTemplate: string
  inputArtifacts: string[]
  requiredOutputs: string[]
  workspaceMode?: WorkspaceMode
  maxRetries: number
  timeoutSeconds: number
  condition?: string
}

export interface WorkflowStageGroup {
  key: string
  name: string
  execution: 'serial' | 'parallel'
  completion: 'all' | 'any'
  nodes: WorkflowNode[]
}

export interface WorkflowDefinition {
  id: string
  projectId: string
  name: string
  description: string
  triggerMode: 'manual' | 'automatic'
  repositoryBindingId: string | null
  stages: WorkflowStageGroup[]
  failurePolicy: 'pause' | 'stop' | 'return_to_stage'
  isDefault: boolean
  status: 'active' | 'archived'
  createdByUserId: number
  version: number
  createdAt: string
  updatedAt: string
}

export type ProjectWorkflowAutomationTrigger =
  | 'manual'
  | 'cron'
  | 'interval'
  | 'one_time'
  | 'webhook'

export interface ProjectWorkflowAutomation {
  id: string
  projectId: string
  name: string
  description: string
  triggerType: ProjectWorkflowAutomationTrigger
  triggerConfig: Record<string, unknown>
  workflowId: string
  repositoryBindingId: string | null
  executionTarget: ExecutionTargetRef
  workspaceMode: WorkspaceMode
  taskTemplate: Record<string, unknown>
  payloadMapping: Record<string, string>
  webhookConfigured: boolean
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  createdByUserId: number
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProjectWorkflowAutomationRun {
  id: string
  automationId: string
  triggerType: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  loopItemId: string | null
  workflowRunId: string | null
  scheduledFor: string | null
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectWorkflowAutomationInput {
  name: string
  description: string
  triggerType: ProjectWorkflowAutomationTrigger
  triggerConfig: Record<string, unknown>
  workflowId: string
  repositoryBindingId?: string
  executionTarget: ExecutionTargetRef
  workspaceMode: WorkspaceMode
  taskTemplate: Record<string, unknown>
  payloadMapping: Record<string, string>
  enabled: boolean
}

export interface TaskExecutionBinding {
  id: number
  itemId: string
  targetType: ExecutionActorType | 'workflow'
  targetId: string
  targetSnapshot: Record<string, unknown>
  repositoryBindingId: string | null
  executionTarget: ExecutionTargetRef
  workspaceMode: WorkspaceMode
  createdByUserId: number
  version: number
  createdAt: string
  updatedAt: string
}

export type WorkflowStatus =
  | 'pending'
  | 'waiting_approval'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'completed'

export interface WorkflowRun {
  id: string
  itemId: string
  workflowDefinitionId: string | null
  status: WorkflowStatus
  currentGroupKey: string | null
  repositoryBindingId: string | null
  executionTarget: ExecutionTargetRef
  executionTargetSnapshot: Record<string, unknown>
  failureCode: string | null
  failureMessage: string | null
  triggerMessageId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type StageStatus =
  | 'pending'
  | 'waiting_approval'
  | 'queued'
  | 'claimed'
  | 'running'
  | 'passed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'skipped'

export interface StageRun {
  id: string
  workflowRunId: string
  groupKey: string
  nodeKey: string
  nodeType: WorkflowNodeType
  targetType: string | null
  targetId: string | null
  targetSnapshot: Record<string, unknown>
  executionTarget: ExecutionTargetRef
  status: StageStatus
  attempt: number
  loopItemExecutionId: number | null
  runtimeInstanceId: string | null
  runtimeTaskId: string | null
  workspaceId: string | null
  inputSnapshot: Record<string, unknown>
  output: Record<string, unknown>
  failureCode: string | null
  failureMessage: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface WorkflowArtifact {
  id: string
  workflowRunId: string
  stageRunId: string
  artifactType: string
  schemaVersion: number
  content: Record<string, unknown>
  objectKey: string | null
  sha256: string | null
  createdAt: string
}

export interface WorkflowRunDetail extends WorkflowRun {
  stages: StageRun[]
  artifacts: WorkflowArtifact[]
}

export interface TaskWorkspace {
  id: string
  itemId: string
  repositoryBindingId: string
  executionTarget: ExecutionTargetRef
  sourceWorkspacePath: string | null
  workspacePath: string | null
  workspaceKind: string
  branchName: string
  baseBranch: string
  headCommit: string | null
  status: string
  cleanupPolicy: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface DevelopmentCheck {
  id: string
  providerCheckId: string
  name: string
  status: string
  conclusion: string | null
  detailsUrl: string | null
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

export interface DevelopmentReviewThread {
  id: string
  providerThreadId: string
  providerCommentId: string | null
  path: string | null
  line: number | null
  side: string | null
  author: string | null
  body: string
  url: string | null
  status: 'open' | 'resolved' | 'outdated'
  reviewState: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskDevelopment {
  id: string
  itemId: string
  repositoryBindingId: string
  workspace: TaskWorkspace | null
  branchName: string
  baseBranch: string
  headCommit: string | null
  provider: string
  pullRequestId: string | null
  pullRequestNumber: number | null
  pullRequestUrl: string | null
  pullRequestState: string | null
  draft: boolean
  mergeableState: string | null
  reviewDecision: string | null
  ciState: string | null
  mergedCommit: string | null
  checks: DevelopmentCheck[]
  reviewThreads: DevelopmentReviewThread[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface TaskExecutionBindingInput {
  version?: number
  actor?: ExecutionActorRef
  workflowId?: string
  repositoryBindingId?: string
  executionTarget: ExecutionTargetRef
  workspaceMode: WorkspaceMode
  startAfterSave?: boolean
}

export interface ProjectAgentSquadInput {
  name: string
  leaderAgentId: string
  memberAgentIds: string[]
  routingInstructions: string
  maxParallelMembers: number
}

export interface SquadRoutePreview {
  squadId: string
  leaderAgentId: string
  selectedMembers: Array<{
    agentId: string
    instruction: string
    requiredArtifacts: string[]
    executionMode: 'serial' | 'parallel'
  }>
  explanation: string
}

export interface RepositoryBindingInput {
  provider: RepositoryBinding['provider']
  repositoryIdentity: string
  repositoryUrl: string
  defaultBranch: string
  localProjectId?: number
  defaultExecutionTarget?: ExecutionTargetRef
  credentialRef?: string
  workspacePolicy: Record<string, unknown>
  gitPolicy: Record<string, unknown>
  providerSettings: Record<string, unknown>
}

export interface WorkflowDefinitionInput {
  name: string
  description: string
  triggerMode: WorkflowDefinition['triggerMode']
  repositoryBindingId?: string
  stages: WorkflowStageGroup[]
  failurePolicy: WorkflowDefinition['failurePolicy']
  isDefault: boolean
}

export interface ConfigurationValidation {
  valid: boolean
  issues: string[]
}

export function createProjectWorkflowApi(client: HttpClient) {
  const itemBase = (projectId: string, itemId: string) =>
    `/v1/cloud-projects/${projectId}/loop-items/${itemId}`

  return {
    listSquads(projectId: string) {
      return client.get<ProjectAgentSquad[]>(`/v1/cloud-projects/${projectId}/agent-squads`)
    },
    createSquad(projectId: string, input: ProjectAgentSquadInput) {
      return client.post<ProjectAgentSquad>(`/v1/cloud-projects/${projectId}/agent-squads`, input)
    },
    updateSquad(
      projectId: string,
      squadId: string,
      input: Partial<ProjectAgentSquadInput> & {
        version: number
        status?: ProjectAgentSquad['status']
      }
    ) {
      return client.patch<ProjectAgentSquad>(
        `/v1/cloud-projects/${projectId}/agent-squads/${squadId}`,
        input
      )
    },
    previewSquadRoute(projectId: string, squadId: string, task: string) {
      return client.post<SquadRoutePreview>(
        `/v1/cloud-projects/${projectId}/agent-squads/${squadId}/preview-route`,
        { task }
      )
    },
    listRepositories(projectId: string) {
      return client.get<RepositoryBinding[]>(`/v1/cloud-projects/${projectId}/repositories`)
    },
    createRepository(projectId: string, input: RepositoryBindingInput) {
      return client.post<RepositoryBinding>(`/v1/cloud-projects/${projectId}/repositories`, input)
    },
    updateRepository(
      projectId: string,
      bindingId: string,
      input: Partial<RepositoryBindingInput> & {
        version: number
        status?: RepositoryBinding['status']
      }
    ) {
      return client.patch<RepositoryBinding>(
        `/v1/cloud-projects/${projectId}/repositories/${bindingId}`,
        input
      )
    },
    validateRepository(projectId: string, bindingId: string) {
      return client.post<ConfigurationValidation>(
        `/v1/cloud-projects/${projectId}/repositories/${bindingId}/validate`,
        {}
      )
    },
    listWorkflows(projectId: string) {
      return client.get<WorkflowDefinition[]>(`/v1/cloud-projects/${projectId}/workflows`)
    },
    createWorkflow(projectId: string, input: WorkflowDefinitionInput) {
      return client.post<WorkflowDefinition>(`/v1/cloud-projects/${projectId}/workflows`, input)
    },
    validateWorkflow(projectId: string, input: WorkflowDefinitionInput) {
      return client.post<ConfigurationValidation>(
        `/v1/cloud-projects/${projectId}/workflows/validate`,
        input
      )
    },
    updateWorkflow(
      projectId: string,
      workflowId: string,
      input: Partial<WorkflowDefinitionInput> & {
        version: number
        status?: WorkflowDefinition['status']
      }
    ) {
      return client.patch<WorkflowDefinition>(
        `/v1/cloud-projects/${projectId}/workflows/${workflowId}`,
        input
      )
    },
    listAutomations(projectId: string) {
      return client.get<ProjectWorkflowAutomation[]>(
        `/v1/cloud-projects/${projectId}/workflow-automations`
      )
    },
    createAutomation(projectId: string, input: ProjectWorkflowAutomationInput) {
      return client.post<ProjectWorkflowAutomation>(
        `/v1/cloud-projects/${projectId}/workflow-automations`,
        input
      )
    },
    updateAutomation(
      projectId: string,
      automationId: string,
      input: Partial<ProjectWorkflowAutomationInput> & { version: number }
    ) {
      return client.patch<ProjectWorkflowAutomation>(
        `/v1/cloud-projects/${projectId}/workflow-automations/${automationId}`,
        input
      )
    },
    rotateAutomationWebhook(projectId: string, automationId: string) {
      return client.post<{
        automationId: string
        webhookToken: string
        webhookSecret: string
      }>(`/v1/cloud-projects/${projectId}/workflow-automations/${automationId}/webhook/rotate`, {})
    },
    listAutomationRuns(projectId: string, automationId: string) {
      return client.get<ProjectWorkflowAutomationRun[]>(
        `/v1/cloud-projects/${projectId}/workflow-automations/${automationId}/runs`
      )
    },
    runAutomation(
      projectId: string,
      automationId: string,
      input: { idempotencyKey?: string; payload?: Record<string, unknown> } = {}
    ) {
      return client.post<ProjectWorkflowAutomationRun>(
        `/v1/cloud-projects/${projectId}/workflow-automations/${automationId}/run`,
        input
      )
    },
    getTaskBinding(projectId: string, itemId: string) {
      return client.get<TaskExecutionBinding | null>(
        `${itemBase(projectId, itemId)}/execution-binding`
      )
    },
    upsertTaskBinding(projectId: string, itemId: string, input: TaskExecutionBindingInput) {
      return client.put<TaskExecutionBinding>(
        `${itemBase(projectId, itemId)}/execution-binding`,
        input
      )
    },
    listRuns(projectId: string, itemId: string) {
      return client.get<WorkflowRun[]>(`${itemBase(projectId, itemId)}/workflow/runs`)
    },
    getRun(projectId: string, itemId: string, runId: string) {
      return client.get<WorkflowRunDetail>(`${itemBase(projectId, itemId)}/workflow/runs/${runId}`)
    },
    getTaskDevelopment(projectId: string, itemId: string) {
      return client.get<TaskDevelopment[]>(`${itemBase(projectId, itemId)}/development`)
    },
    createPullRequest(
      projectId: string,
      itemId: string,
      developmentId: string,
      input: { title: string; body: string; draft: boolean }
    ) {
      return client.post<TaskDevelopment>(
        `${itemBase(projectId, itemId)}/development/${developmentId}/pull-request`,
        input
      )
    },
    refreshPullRequest(projectId: string, itemId: string, developmentId: string) {
      return client.post<TaskDevelopment>(
        `${itemBase(projectId, itemId)}/development/${developmentId}/refresh`,
        {}
      )
    },
    mergePullRequest(
      projectId: string,
      itemId: string,
      developmentId: string,
      input: { version: number; method: 'merge' | 'squash' | 'rebase' }
    ) {
      return client.post<TaskDevelopment>(
        `${itemBase(projectId, itemId)}/development/${developmentId}/merge`,
        input
      )
    },
    startRun(projectId: string, itemId: string, idempotencyKey: string, triggerMessageId?: string) {
      return client.post<WorkflowRun>(`${itemBase(projectId, itemId)}/workflow/start`, {
        idempotencyKey,
        triggerMessageId,
      })
    },
    approveStage(
      projectId: string,
      itemId: string,
      runId: string,
      stageId: string,
      version: number,
      reason?: string
    ) {
      return client.post<WorkflowRunDetail>(
        `${itemBase(projectId, itemId)}/workflow/runs/${runId}/stages/${stageId}/approve`,
        { version, reason }
      )
    },
    rejectStage(
      projectId: string,
      itemId: string,
      runId: string,
      stageId: string,
      version: number,
      reason?: string
    ) {
      return client.post<WorkflowRunDetail>(
        `${itemBase(projectId, itemId)}/workflow/runs/${runId}/stages/${stageId}/reject`,
        { version, reason }
      )
    },
    retryStage(projectId: string, itemId: string, runId: string, stageId: string, version: number) {
      return client.post<WorkflowRunDetail>(
        `${itemBase(projectId, itemId)}/workflow/runs/${runId}/stages/${stageId}/retry`,
        { version }
      )
    },
    cancelRun(projectId: string, itemId: string, runId: string, version: number) {
      return client.post<WorkflowRunDetail>(
        `${itemBase(projectId, itemId)}/workflow/runs/${runId}/cancel`,
        { version }
      )
    },
  }
}
