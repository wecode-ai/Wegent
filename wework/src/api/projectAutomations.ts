import type { HttpClient } from './http'
import type { LocalLoopItemExecution } from './local/localDelivery'

export type ProjectAutomationRunStatus =
  | 'pending'
  | 'queued'
  | 'waiting_device'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

interface ProjectAutomationRuleBase {
  id: string
  projectId: string
  name: string
  prompt: string
  triggerType: 'schedule' | 'event' | 'workflow'
  eventType: 'task.created' | null
  eventConfig: Record<string, unknown>
  webhookEventId: string | null
  webhookSecret: string | null
  cronExpression: string | null
  timezone: string
  agentName: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunStatus: ProjectAutomationRunStatus | null
  version: number
  createdAt: string
  updatedAt: string
}

export type ProjectAutomationRule = ProjectAutomationRuleBase &
  (
    | {
        assignmentMode: 'manual'
        managerType: null
        agentId: string
        wegentTeamId: null
        model: string | null
        executionEnvironment: 'local' | 'cloud'
        executionDeviceId: string | null
      }
    | {
        assignmentMode: 'ai_managed'
        managerType: 'custom'
        agentId: null
        wegentTeamId: null
        model: string
        executionEnvironment: 'local' | 'cloud'
        executionDeviceId: string
      }
    | {
        assignmentMode: 'ai_managed'
        managerType: 'wegent'
        agentId: null
        wegentTeamId: number
        model: null
        executionEnvironment: 'managed'
        executionDeviceId: null
      }
  )

export interface ProjectAutomationRun {
  id: string
  automationId: string
  projectId: string
  trigger: 'scheduled' | 'manual' | 'event'
  status: ProjectAutomationRunStatus
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

interface ProjectAutomationInputBase {
  name: string
  prompt: string
  triggerType: 'schedule' | 'event' | 'workflow'
  eventType: 'task.created' | null
  eventConfig: Record<string, unknown>
  cronExpression: string | null
  timezone: string
  enabled: boolean
}

export type ProjectAutomationInput = ProjectAutomationInputBase &
  (
    | {
        assignmentMode: 'manual'
        managerType: null
        agentId: string
        wegentTeamId: null
        model: null
        executionEnvironment: null
        executionDeviceId: null
      }
    | {
        assignmentMode: 'ai_managed'
        managerType: 'custom'
        agentId: null
        wegentTeamId: null
        model: string
        executionEnvironment: 'local' | 'cloud'
        executionDeviceId: string
      }
    | {
        assignmentMode: 'ai_managed'
        managerType: 'wegent'
        agentId: null
        wegentTeamId: number
        model: null
        executionEnvironment: null
        executionDeviceId: null
      }
  )

function cloudExecution(row: Record<string, unknown>): LocalLoopItemExecution {
  const payload = (row.runtimePayload as Record<string, unknown> | null) ?? null
  const bots = Array.isArray(payload?.bot) ? payload.bot : []
  const bot = (bots[0] as Record<string, unknown> | undefined) ?? {}
  return {
    id: Number(row.id),
    loop_item_id: String(row.loopItemId ?? ''),
    cloud_project_id: String(row.cloudProjectId ?? ''),
    task_title: String(row.taskTitle ?? ''),
    task_status: row.taskStatus == null ? null : String(row.taskStatus),
    task_priority: row.taskPriority == null ? null : String(row.taskPriority),
    agent_id: String(row.agentId ?? ''),
    assigner_user_id: Number(row.assignerUserId ?? 0),
    execution_environment: String(row.executionEnvironment ?? ''),
    execution_device_id: row.executionDeviceId == null ? null : String(row.executionDeviceId),
    runtime_instance_id: row.runtimeInstanceId == null ? null : String(row.runtimeInstanceId),
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
    cancel_requested_at: row.cancelRequestedAt == null ? null : String(row.cancelRequestedAt),
    attempt_no: Number(row.attemptNo ?? 1),
    previous_execution_id: row.previousExecutionId == null ? null : Number(row.previousExecutionId),
    execution_scope: String(row.executionScope ?? ''),
    last_event_seq: Number(row.lastEventSeq ?? 0),
    termination_reason: String(row.terminationReason ?? ''),
    retry_attempt: Number(row.retryAttempt ?? 0),
    error_message: String(row.errorMessage ?? ''),
    execution_note: String(row.executionNote ?? ''),
    runtime_device_id: row.runtimeDeviceId == null ? null : String(row.runtimeDeviceId),
    runtime_task_id: row.runtimeTaskId == null ? null : String(row.runtimeTaskId),
    version: Number(row.version ?? 1),
    created_at: String(row.createdAt ?? ''),
    updated_at: String(row.updatedAt ?? ''),
    agent_name: String(bot.name ?? 'AI'),
    agent_system_prompt: String(bot.system_prompt ?? bot.systemPrompt ?? ''),
    agent_model: payload?.modelId == null ? null : String(payload.modelId),
    agent_max_concurrent_executions: Number(row.agentMaxConcurrentExecutions ?? 1),
    runtime_payload: payload,
  }
}

export function createProjectAutomationApi(client: HttpClient) {
  return {
    claimNext(claim: { execution_device_id: string; lease_seconds: number }) {
      return client
        .post<Record<string, unknown> | null>('/v1/loop-item-executions/claim-my-next', claim)
        .then(row => (row ? cloudExecution(row) : null))
    },
    heartbeat(
      execution: Pick<LocalLoopItemExecution, 'id' | 'cloud_project_id'>,
      runtimeDeviceId: string | null,
      runtimeTaskId: string | null,
      leaseSeconds = 300
    ) {
      return client.post<LocalLoopItemExecution | null>(
        `/v1/cloud-projects/${execution.cloud_project_id}/executions/${execution.id}/heartbeat`,
        {
          runtime_device_id: runtimeDeviceId,
          runtime_task_id: runtimeTaskId,
          lease_seconds: leaseSeconds,
        }
      )
    },
    startRequested(
      execution: Pick<LocalLoopItemExecution, 'id' | 'cloud_project_id'>,
      runtimeDeviceId: string,
      runtimeTaskId: string
    ) {
      return client.post<LocalLoopItemExecution | null>(
        `/v1/cloud-projects/${execution.cloud_project_id}/executions/${execution.id}/start-requested`,
        {
          runtime_device_id: runtimeDeviceId,
          runtime_task_id: runtimeTaskId,
        }
      )
    },
    dispatchUnknown(
      execution: Pick<LocalLoopItemExecution, 'id' | 'cloud_project_id'>,
      runtimeDeviceId: string,
      runtimeTaskId: string,
      error: string
    ) {
      return client.post<LocalLoopItemExecution | null>(
        `/v1/cloud-projects/${execution.cloud_project_id}/executions/${execution.id}/dispatch-unknown`,
        {
          runtime_device_id: runtimeDeviceId,
          runtime_task_id: runtimeTaskId,
          error,
        }
      )
    },
    runtimeStart(
      execution: Pick<LocalLoopItemExecution, 'id' | 'cloud_project_id'>,
      runtimeDeviceId: string,
      runtimeTaskId: string,
      prompt: string | null,
      model?: string | null
    ) {
      return client.post<LocalLoopItemExecution | null>(
        `/v1/cloud-projects/${execution.cloud_project_id}/executions/${execution.id}/runtime-start`,
        {
          runtime_device_id: runtimeDeviceId,
          runtime_task_id: runtimeTaskId,
          prompt: prompt ?? null,
          model: model ?? null,
        }
      )
    },
    dispatchFailed(
      execution: Pick<LocalLoopItemExecution, 'id' | 'cloud_project_id'>,
      error: string
    ) {
      return client.post<LocalLoopItemExecution | null>(
        `/v1/cloud-projects/${execution.cloud_project_id}/executions/${execution.id}/dispatch-failed`,
        { error }
      )
    },
    list(projectId: string) {
      return client.get<ProjectAutomationRule[]>(`/v1/cloud-projects/${projectId}/automations`)
    },
    create(projectId: string, input: ProjectAutomationInput) {
      return client.post<ProjectAutomationRule>(
        `/v1/cloud-projects/${projectId}/automations`,
        input
      )
    },
    update(
      projectId: string,
      automationId: string,
      input: Partial<ProjectAutomationInput> & Pick<ProjectAutomationRule, 'version'>
    ) {
      return client.patch<ProjectAutomationRule>(
        `/v1/cloud-projects/${projectId}/automations/${automationId}`,
        input
      )
    },
    delete(projectId: string, automationId: string) {
      return client.delete<void>(`/v1/cloud-projects/${projectId}/automations/${automationId}`)
    },
    rotateWebhookSecret(projectId: string, automationId: string) {
      return client.post<ProjectAutomationRule>(
        `/v1/cloud-projects/${projectId}/automations/${automationId}/rotate-webhook-secret`,
        {}
      )
    },
    runNow(projectId: string, automationId: string) {
      return client.post<ProjectAutomationRun>(
        `/v1/cloud-projects/${projectId}/automations/${automationId}/run`,
        {}
      )
    },
    runWorkflowNode(
      projectId: string,
      itemId: string,
      workflowNodeId: string,
      automationId: string
    ) {
      const query = new URLSearchParams({ automation_id: automationId })
      return client.post<ProjectAutomationRun>(
        `/v1/cloud-projects/${projectId}/loop-items/${encodeURIComponent(itemId)}/workflow-nodes/${encodeURIComponent(workflowNodeId)}/run?${query.toString()}`,
        {}
      )
    },
    listRuns(projectId: string, automationId: string) {
      return client.get<ProjectAutomationRun[]>(
        `/v1/cloud-projects/${projectId}/automations/${automationId}/runs`
      )
    },
    cancelRun(projectId: string, runId: string) {
      return client.post<ProjectAutomationRun>(
        `/v1/cloud-projects/${projectId}/automation-runs/${runId}/cancel`,
        {}
      )
    },
    retryRun(projectId: string, runId: string) {
      return client.post<ProjectAutomationRun>(
        `/v1/cloud-projects/${projectId}/automation-runs/${runId}/retry`,
        {}
      )
    },
  }
}
