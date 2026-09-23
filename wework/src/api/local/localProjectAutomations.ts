import type { WorkspaceAutomationRun, WorkspaceProjectManagerRun } from '@wegent/collaboration'
import type { LocalLoopItemExecution } from './localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

type Request = <T>(method: string, params: Record<string, unknown>) => Promise<T>

export function createLocalProjectAutomationApi(
  request: Request,
  runtime: NonNullable<WorkbenchServices['runtimeWorkApi']>
) {
  return {
    runManager(projectId: string, instruction: string) {
      return request<WorkspaceProjectManagerRun>('projects.manager.run', {
        project_id: projectId,
        instruction,
      })
    },
    listManagerRuns(projectId: string) {
      return request<WorkspaceProjectManagerRun[]>('projects.manager.runs', {
        project_id: projectId,
      })
    },
    decideManagerAction(
      projectId: string,
      runId: string,
      actionId: string,
      approve: boolean,
      version: number
    ) {
      return request<import('@wegent/collaboration').WorkspaceProjectManagerAction>(
        'projects.manager.decide',
        {
          project_id: projectId,
          run_id: runId,
          action_id: actionId,
          approve,
          version,
        }
      )
    },
    run(projectId: string, automationId: string, issueId?: string) {
      return request<WorkspaceAutomationRun[]>('projects.automation.run', {
        project_id: projectId,
        automation_id: automationId,
        issue_id: issueId,
      })
    },
    listRuns(projectId: string, automationId: string) {
      return request<WorkspaceAutomationRun[]>('projects.automation.runs', {
        project_id: projectId,
        automation_id: automationId,
      })
    },
    async cancelRun(projectId: string, runId: string) {
      const { run, executions } = await request<{
        run: WorkspaceAutomationRun
        executions: LocalLoopItemExecution[]
      }>('projects.automation.cancel', { project_id: projectId, run_id: runId })
      for (const execution of executions) {
        if (execution.status === 'cancel_requested') {
          if (!execution.runtime_device_id || !execution.runtime_task_id)
            throw new Error('Execution has no runtime identity')
          await runtime.cancelRuntimeTask({
            deviceId: execution.runtime_device_id,
            taskId: execution.runtime_task_id,
          })
        }
      }
      const runs = await request<WorkspaceAutomationRun[]>('projects.automation.runs', {
        project_id: projectId,
        automation_id: run.automationId,
      })
      const updated = runs.find(item => item.id === runId)
      if (!updated) throw new Error('Automation run not found after cancellation')
      return updated
    },
    async retryRun(projectId: string, runId: string) {
      const runs = await request<WorkspaceAutomationRun[]>('projects.automation.retry', {
        project_id: projectId,
        run_id: runId,
      })
      if (runs.length !== 1) throw new Error('Retry did not produce exactly one automation run')
      return runs[0]
    },
  }
}
