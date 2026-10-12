import type { HttpClient } from './http'
import type { LocalLoopItemExecution } from './local/localDelivery'
import type { ProjectWorkflowDefinition } from './deliveries'

export type ProjectAutomationRunStatus =
  | 'pending'
  | 'queued'
  | 'waiting_runtime'
  | 'waiting_device'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type ProjectAutomationEventType =
  | 'task.created'
  | 'task.tag_added'
  | 'task.status_changed'
  | 'change_request.checks_failed'
  | 'change_request.merge_conflict'
  | 'change_request.review_submitted'
  | 'change_request.comment_created'
  | 'document.changed'

export type ProjectAutomationTargetKind = 'human' | 'agent' | 'collaboration_group'

export interface ProjectAutomationRule {
  id: string
  projectId: string
  name: string
  prompt: string
  triggerType: 'manual' | 'schedule' | 'event' | 'workflow'
  eventType: ProjectAutomationEventType | null
  eventConfig: Record<string, unknown>
  cronExpression: string | null
  timezone: string
  executionDeviceId: string | null
  targetKind: ProjectAutomationTargetKind
  targetId: string
  targetName: string
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
  taskTitle?: string | null
  backendTaskId: number | null
  deviceId: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  retryable?: boolean
  triggerType?: 'schedule' | 'event' | 'workflow' | null
  eventType?: ProjectAutomationEventType | null
  eventConfig?: Record<string, unknown> | null
}

export interface ProjectAutomationInput {
  name: string
  prompt: string
  triggerType: 'manual' | 'schedule' | 'event' | 'workflow'
  eventType: ProjectAutomationEventType | null
  eventConfig: Record<string, unknown>
  cronExpression: string | null
  timezone: string
  executionDeviceId: string | null
  targetKind: ProjectAutomationTargetKind
  targetId: string
  enabled: boolean
}

export interface ProjectAutomationWorkflowMigrationResult {
  automation: ProjectAutomationRule
  projectVersion: number
  workflowAutomationId: string
}

export interface ProjectAutomationDeleteResult {
  projectVersion: number
  workflowAutomationId: string | null
}

export function createProjectAutomationApi(client: HttpClient) {
  return {
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
    migrateWorkflow(
      projectId: string,
      input: {
        projectVersion: number
        automation: ProjectAutomationInput
        workflowDefinition: ProjectWorkflowDefinition
      }
    ) {
      return client.post<ProjectAutomationWorkflowMigrationResult>(
        `/v1/cloud-projects/${projectId}/automations/migrate-workflow`,
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
      return client.delete<ProjectAutomationDeleteResult>(
        `/v1/cloud-projects/${projectId}/automations/${automationId}`
      )
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
    retryRun(projectId: string, runId: string) {
      return client.post<ProjectAutomationRun>(
        `/v1/cloud-projects/${projectId}/automation-runs/${runId}/retry`,
        {}
      )
    },
  }
}
