import type { HttpClient } from './http'
import type { LocalLoopItemExecution } from './local/localDelivery'

export type ProjectAutomationRunStatus =
  | 'pending'
  | 'waiting_device'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export interface ProjectAutomationRule {
  id: string
  projectId: string
  name: string
  prompt: string
  triggerType: 'schedule' | 'event'
  eventType: 'task.created' | null
  eventConfig: Record<string, unknown>
  assignmentMode: 'manual' | 'automatic'
  webhookEventId: string | null
  webhookSecret: string | null
  cronExpression: string | null
  timezone: string
  agentId: string | null
  agentName: string
  executionEnvironment: 'local' | 'cloud'
  executionDeviceId: string | null
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunStatus: ProjectAutomationRunStatus | null
  version: number
  createdAt: string
  updatedAt: string
}

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
  deviceId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectAutomationInput {
  name: string
  prompt: string
  triggerType: 'schedule' | 'event'
  eventType: 'task.created' | null
  eventConfig: Record<string, unknown>
  assignmentMode: 'manual' | 'automatic'
  cronExpression: string | null
  timezone: string
  agentId: string | null
  enabled: boolean
}

function cloudExecution(row: Record<string, unknown>): LocalLoopItemExecution {
  const payload = (row.executionPayload as Record<string, unknown> | null) ?? null
  const request = (payload?.executionRequest as Record<string, unknown> | undefined) ?? {}
  const bots = Array.isArray(request.bot) ? request.bot : []
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
    status: String(row.status ?? ''),
    priority_weight: Number(row.priorityWeight ?? 0),
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
    execution_payload: payload,
  }
}

export function createProjectAutomationApi(client: HttpClient) {
  return {
    claimNext(claim: {
      execution_device_id: string
      device_capacity: number
      lease_seconds: number
    }) {
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
    fail(execution: Pick<LocalLoopItemExecution, 'id' | 'cloud_project_id'>, error: string) {
      return client.post<LocalLoopItemExecution | null>(
        `/v1/cloud-projects/${execution.cloud_project_id}/executions/${execution.id}/fail`,
        { error, requeue: false }
      )
    },
    complete(
      execution: Pick<LocalLoopItemExecution, 'id' | 'cloud_project_id'>,
      note?: string | null
    ) {
      return client.post<LocalLoopItemExecution | null>(
        `/v1/cloud-projects/${execution.cloud_project_id}/executions/${execution.id}/complete`,
        { note: note ?? null }
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
    runNow(projectId: string, automationId: string) {
      return client.post<ProjectAutomationRun>(
        `/v1/cloud-projects/${projectId}/automations/${automationId}/run`,
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
  }
}
