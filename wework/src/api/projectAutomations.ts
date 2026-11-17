import type { HttpClient } from './http'
import { mapAutomationBackendRunDto, type RunnerSelection } from '@wegent/collaboration'
import type { AutomationBackendRun, AutomationRunStatus } from '@wegent/collaboration/automation'
import type { LocalLoopItemExecution } from './local/localDelivery'
import type { ProjectWorkflowDefinition } from './deliveries'

export type ProjectAutomationRunStatus = AutomationRunStatus

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
  workdayOnly?: boolean
  timezone: string
  executionDeviceId: string | null
  runnerSelection?: RunnerSelection | null
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

export type ProjectAutomationRun = AutomationBackendRun

export interface ProjectAutomationInput {
  name: string
  prompt: string
  triggerType: 'manual' | 'schedule' | 'event' | 'workflow'
  eventType: ProjectAutomationEventType | null
  eventConfig: Record<string, unknown>
  cronExpression: string | null
  workdayOnly?: boolean
  timezone: string
  executionDeviceId: string | null
  runnerSelection?: RunnerSelection | null
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
    async runNow(projectId: string, automationId: string) {
      return mapAutomationBackendRunDto(
        await client.post<ProjectAutomationRun>(
          `/v1/cloud-projects/${projectId}/automations/${automationId}/run`,
          {}
        )
      )
    },
    async listRuns(projectId: string, automationId: string) {
      const runs = await client.get<ProjectAutomationRun[]>(
        `/v1/cloud-projects/${projectId}/automations/${automationId}/runs`
      )
      return runs.map(mapAutomationBackendRunDto)
    },
    async cancelRun(projectId: string, runId: string) {
      return mapAutomationBackendRunDto(
        await client.post<ProjectAutomationRun>(
          `/v1/cloud-projects/${projectId}/automation-runs/${runId}/cancel`,
          {}
        )
      )
    },
    async retryRun(projectId: string, runId: string) {
      return mapAutomationBackendRunDto(
        await client.post<ProjectAutomationRun>(
          `/v1/cloud-projects/${projectId}/automation-runs/${runId}/retry`,
          {}
        )
      )
    },
  }
}
