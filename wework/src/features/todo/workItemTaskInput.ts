import type { CloudLoopItem } from '@/api/deliveries'
import { workflowNodeExecutionMode } from '@/api/issueWorkflow'

export function isSelfManagedWorkItem(item: Pick<CloudLoopItem, 'workflow'>): boolean {
  const workflow = item.workflow
  if (!workflow) return true
  const stageMode = workflow.stage_mode ?? (workflow.nodes.length > 0 ? 'dag' : 'none')
  return stageMode === 'none' && (workflow.advancement_policy ?? 'manual') === 'manual'
}

export function workItemTaskInput(item: Pick<CloudLoopItem, 'title' | 'description'>): string {
  return item.title.trim() || item.description?.trim() || ''
}

export function shouldPrepareWorkItemTask(
  item: Pick<
    CloudLoopItem,
    'assignee_agent_id' | 'assignee_team_id' | 'parent_id' | 'status' | 'workflow'
  >,
  previousStatus: string,
  taskBindingCount: number
): boolean {
  return (
    isSelfManagedWorkItem(item) &&
    !item.assignee_agent_id &&
    !item.assignee_team_id &&
    item.parent_id === null &&
    item.status !== previousStatus &&
    taskBindingCount === 0
  )
}

export function shouldRevealWorkItemWorkflowActions(
  item: Pick<CloudLoopItem, 'workflow'>,
  statusChanged: boolean
): boolean {
  return (
    statusChanged &&
    !isSelfManagedWorkItem(item) &&
    Boolean(
      item.workflow?.nodes.some(
        stage => workflowNodeExecutionMode(stage) === 'human' && stage.status === 'ready'
      )
    )
  )
}
