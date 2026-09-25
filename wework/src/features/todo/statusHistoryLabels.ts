import type { TFunction } from 'i18next'

const STATUS_ACTION_KEYS: Record<string, string> = {
  create: 'todo.status_action_create',
  user_update: 'todo.status_action_user_update',
  ai_started: 'todo.status_action_ai_started',
  ai_completed: 'todo.status_action_ai_completed',
  task_started: 'todo.status_action_task_started',
  delivery: 'todo.status_action_delivery',
  status_removed: 'todo.status_action_status_removed',
  workflow_plan_approved: 'todo.status_action_workflow_plan_approved',
  workflow_task_progress: 'todo.status_action_workflow_task_progress',
  workflow_outcome_passed: 'todo.status_action_workflow_outcome_passed',
  workflow_outcome_needs_rework: 'todo.status_action_workflow_outcome_needs_rework',
  workflow_manager_review: 'todo.status_action_workflow_manager_review',
  workflow_manager_completed: 'todo.status_action_workflow_manager_completed',
  workflow_review_approved: 'todo.status_action_workflow_review_approved',
  workflow_stage_advanced: 'todo.status_action_workflow_stage_advanced',
  workflow_replanned: 'todo.status_action_workflow_replanned',
  workflow_paused: 'todo.status_action_workflow_paused',
  workflow_resumed: 'todo.status_action_workflow_resumed',
  reassignment: 'todo.status_action_reassignment',
  unassigned: 'todo.status_action_unassigned',
  local_status_change: 'todo.status_action_local_status_change',
}

export function statusHistoryLabels(t: TFunction) {
  return {
    system: t('todo.status_history_system', '系统/机器人'),
    unset: t('todo.status_history_unset', '未设置'),
    initial: t('todo.status_history_initial', '初始状态'),
    accept: t('todo.status_action_accept', '验收'),
    action: (trigger: string) =>
      t(STATUS_ACTION_KEYS[trigger] ?? 'todo.status_action_user_update', trigger),
  }
}
