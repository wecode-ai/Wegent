import type { CloudLoopItem, WorkflowNodeInstance } from '@/api/deliveries'

type TaskEntryStatus = 'pending' | 'in_progress'

export function isSelfManagedWorkItem(item: Pick<CloudLoopItem, 'workflow'>): boolean {
  const workflow = item.workflow
  if (!workflow) return true
  const stageMode = workflow.stage_mode ?? (workflow.nodes.length > 0 ? 'dag' : 'none')
  return stageMode === 'none' && (workflow.advancement_policy ?? 'manual') === 'manual'
}

export function workItemTaskInput(item: Pick<CloudLoopItem, 'title' | 'description'>): string {
  return item.title.trim() || item.description?.trim() || ''
}

export function workflowStageTaskInput(stage: WorkflowNodeInstance): string {
  const sections = [stage.prompt?.trim() ?? '']
  if (stage.required_deliverables?.length) {
    sections.push(
      [
        '完成任务后，请在 Issue 当前阶段的“必要交付物”区域上传以下内容：',
        ...stage.required_deliverables.map(requirement => `- ${requirement}`),
        '上传并提交后，节点将等待人工批准；不要自行宣称已经进入下一阶段。',
      ].join('\n')
    )
  }
  return sections.filter(Boolean).join('\n\n')
}

export function shouldPrepareWorkItemTask(
  item: Pick<CloudLoopItem, 'parent_id' | 'status' | 'workflow'>,
  targetStatus: TaskEntryStatus,
  taskBindingCount: number
): boolean {
  return (
    isSelfManagedWorkItem(item) &&
    item.parent_id === null &&
    item.status !== targetStatus &&
    taskBindingCount === 0
  )
}

export function shouldDeferWorkItemMoveUntilTaskCreated(
  item: Pick<CloudLoopItem, 'parent_id' | 'status' | 'workflow'>,
  targetStatus: TaskEntryStatus,
  taskBindingCount: number
): boolean {
  return (
    targetStatus === 'pending' && shouldPrepareWorkItemTask(item, targetStatus, taskBindingCount)
  )
}

export function shouldRevealWorkItemWorkflowActions(
  item: Pick<CloudLoopItem, 'status' | 'workflow'>,
  targetStatus: TaskEntryStatus
): boolean {
  return (
    item.status === 'inbox' &&
    targetStatus === 'pending' &&
    !isSelfManagedWorkItem(item) &&
    Boolean(
      item.workflow?.nodes.some(stage => !stage.automation_rule_id && stage.status === 'ready')
    )
  )
}
