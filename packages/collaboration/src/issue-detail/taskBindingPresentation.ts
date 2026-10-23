import type { CollaborationTranslate } from '../i18n'
import { isExecutionActive } from './executionStatus'
import type {
  SharedIssueDetailTaskBinding,
  SharedIssueDetailTaskExecutionState,
} from './createSharedIssueDetailPort'

export function taskDeviceLabel(
  task: SharedIssueDetailTaskBinding,
  deviceNamesById: Readonly<Record<string, string>> | undefined
) {
  return deviceNamesById?.[task.device_id]?.trim() || task.device_id
}

export function taskExecutionStatusLabel(
  status: SharedIssueDetailTaskExecutionState['status'],
  translate: CollaborationTranslate
): string {
  const labels: Record<SharedIssueDetailTaskExecutionState['status'], [string, string]> = {
    waiting_approval: ['todo.execution_waiting_approval', '等待审批'],
    queued: ['todo.execution_queued', '排队中'],
    starting: ['todo.execution_starting', '启动中'],
    waiting_runtime: ['todo.execution_waiting_runtime', '等待执行环境'],
    running: ['todo.execution_running', '执行中'],
    cancelling: ['todo.execution_cancelling', '取消中'],
    succeeded: ['todo.execution_succeeded', '已完成'],
    failed: ['todo.execution_failed', '失败'],
    cancelled: ['todo.execution_cancelled', '已取消'],
    skipped: ['todo.execution_skipped', '已跳过'],
    unknown: ['todo.execution_unknown', '状态待同步'],
  }
  const [key, fallback] = labels[status]
  return translate(key, fallback)
}

export function taskExecutionDotClass(
  status: SharedIssueDetailTaskExecutionState['status']
): string {
  if (status === 'running') return 'is-running'
  if (status === 'succeeded' || status === 'skipped') return 'is-success'
  if (status === 'failed' || status === 'cancelled') return 'is-failed'
  if (status !== 'unknown' && isExecutionActive(status)) return 'is-queued'
  return 'is-idle'
}
