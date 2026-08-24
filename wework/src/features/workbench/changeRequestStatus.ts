import type { PullRequestAutoRepairStatus } from '@/api/deliveries'
import type { ChangeRequest } from '@/types/environment'

export type ChangeRequestVisualStatus =
  | 'draft'
  | 'open'
  | 'checks_pending'
  | 'checks_passed'
  | 'checks_failed'
  | 'merge_conflict'
  | 'merge_queue_queued'
  | 'merge_queue_checking'
  | 'merge_queue_failed'
  | 'merge_queue_timed_out'
  | 'merge_queue_conflicting'
  | 'merge_queue_removed'
  | 'closed'
  | 'merged'

const AUTO_REPAIR_STATUS_BY_VISUAL_STATUS: Partial<
  Record<ChangeRequestVisualStatus, PullRequestAutoRepairStatus>
> = {
  checks_failed: 'checks_failed',
  merge_conflict: 'merge_conflict',
  merge_queue_failed: 'merge_queue_failed',
  merge_queue_timed_out: 'merge_queue_timed_out',
  merge_queue_conflicting: 'merge_queue_conflicting',
}

export function changeRequestVisualStatus(changeRequest: ChangeRequest): ChangeRequestVisualStatus {
  if (changeRequest.state === 'merged') return 'merged'
  if (changeRequest.state === 'closed') return 'closed'
  if (changeRequest.mergeQueue === 'failed') return 'merge_queue_failed'
  if (changeRequest.mergeQueue === 'timed_out') return 'merge_queue_timed_out'
  if (changeRequest.mergeQueue === 'conflicting') return 'merge_queue_conflicting'
  if (changeRequest.mergeability === 'conflicting') return 'merge_conflict'
  if (changeRequest.checks === 'failure') return 'checks_failed'
  if (changeRequest.draft) return 'draft'
  if (changeRequest.mergeQueue === 'checking') return 'merge_queue_checking'
  if (changeRequest.mergeQueue === 'queued') return 'merge_queue_queued'
  if (changeRequest.mergeQueue === 'removed') return 'merge_queue_removed'
  if (changeRequest.checks === 'pending') return 'checks_pending'
  if (changeRequest.checks === 'success') return 'checks_passed'
  return 'open'
}

export function autoRepairStatus(changeRequest: ChangeRequest): PullRequestAutoRepairStatus | null {
  const status = changeRequestVisualStatus(changeRequest)
  return AUTO_REPAIR_STATUS_BY_VISUAL_STATUS[status] ?? null
}

export function stoppedTaskNeedsAttention(changeRequest: ChangeRequest | null): boolean {
  return changeRequest?.state === 'open'
}

export function buildChangeRequestRepairPrompt(
  changeRequest: ChangeRequest,
  taskTitle: string,
  customPrompt = ''
): string {
  const status = changeRequestVisualStatus(changeRequest)
  const details = [
    `继续当前任务“${taskTitle}”，修复 PR/MR #${changeRequest.number} 的合并问题。`,
    `当前状态：${status}。`,
    changeRequest.mergeQueueReason ? `Merge Queue 原因：${changeRequest.mergeQueueReason}。` : '',
    `PR/MR 地址：${changeRequest.url}`,
    '请读取最新的 PR/MR 检查与 Merge Queue 日志，从证据定位根因，修复后运行相关测试并推送到当前分支。',
    '继续使用当前 PR/MR，不要创建重复 PR/MR。',
    customPrompt.trim(),
  ]
  return details.filter(Boolean).join('\n')
}

export function changeRequestRepairEventKey(changeRequest: ChangeRequest): string {
  return [
    changeRequest.provider,
    changeRequest.url,
    changeRequest.headBranch ?? '',
    changeRequestVisualStatus(changeRequest),
    changeRequest.updatedAt ?? '',
    changeRequest.mergeQueueReason ?? '',
  ].join('\0')
}

const AUTO_REPAIR_CACHE_KEY = 'wework:change-request-auto-repair:v1'
const activeAutoRepairs = new Set<string>()

function handledAutoRepairs(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_REPAIR_CACHE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

export function claimChangeRequestAutoRepair(key: string): boolean {
  if (activeAutoRepairs.has(key) || handledAutoRepairs().has(key)) return false
  activeAutoRepairs.add(key)
  return true
}

export function completeChangeRequestAutoRepair(key: string, succeeded: boolean): void {
  activeAutoRepairs.delete(key)
  if (!succeeded || typeof window === 'undefined') return
  const handled = handledAutoRepairs()
  handled.add(key)
  try {
    window.localStorage.setItem(AUTO_REPAIR_CACHE_KEY, JSON.stringify([...handled].slice(-500)))
  } catch (error) {
    console.warn('[Wework change requests] Failed to persist auto-repair event', error)
  }
}
