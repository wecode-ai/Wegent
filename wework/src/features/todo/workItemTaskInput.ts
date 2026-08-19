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
        '完成任务后，必须通过 Issue 交付工具逐项提交以下交付物：',
        ...stage.required_deliverables.map(
          requirement =>
            `- [${requirement.id}] ${requirement.name} (${requirement.value_type})${
              requirement.description ? `：${requirement.description}` : ''
            }`
        ),
        '上传文件后，调用 finalize_delivery 时必须传入 fulfillments，并让每个实际结果绑定对应 requirement_id。仅创建 Delivery、上传资产或提交空 fulfillments 都不算完成。提交后等待流程状态更新，不要自行宣称已经进入下一阶段。',
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
