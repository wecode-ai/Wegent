import type { PullRequestAutoRepairStatus } from '@/api/deliveries'
import type { ChangeRequest } from '@/types/environment'
import type { TFunction } from 'i18next'

export type ChangeRequestVisualStatus =
  | 'draft'
  | 'open'
  | 'checks_pending'
  | 'checks_passed'
  | 'checks_failed'
  | 'merge_conflict'
  | 'blocked'
  | 'behind'
  | 'unstable'
  | 'has_hooks'
  | 'merge_queue_queued'
  | 'merge_queue_checking'
  | 'merge_queue_failed'
  | 'merge_queue_timed_out'
  | 'merge_queue_unmergeable'
  | 'merge_queue_locked'
  | 'merge_queue_removed'
  | 'closed'
  | 'merged'
  | 'unknown'

const AUTO_REPAIR_STATUS_BY_VISUAL_STATUS: Partial<
  Record<ChangeRequestVisualStatus, PullRequestAutoRepairStatus>
> = {
  checks_failed: 'checks_failed',
  merge_conflict: 'merge_conflict',
  merge_queue_failed: 'merge_queue_failed',
  merge_queue_timed_out: 'merge_queue_timed_out',
  merge_queue_unmergeable: 'merge_queue_conflicting',
}

export function changeRequestVisualStatus(changeRequest: ChangeRequest): ChangeRequestVisualStatus {
  if (changeRequest.state === 'merged') return 'merged'
  if (changeRequest.state === 'closed') return 'closed'
  if (changeRequest.mergeability === 'conflicting' || changeRequest.mergeStateStatus === 'dirty') {
    return 'merge_conflict'
  }
  if (changeRequest.checks === 'failure') return 'checks_failed'
  if (changeRequest.mergeQueue === 'failed') return 'merge_queue_failed'
  if (changeRequest.mergeQueue === 'timed_out') return 'merge_queue_timed_out'
  if (changeRequest.mergeQueue === 'unmergeable') return 'merge_queue_unmergeable'
  if (
    changeRequest.mergeStateStatus === 'blocked' ||
    changeRequest.reviewDecision === 'changes_requested' ||
    changeRequest.reviewDecision === 'review_required'
  ) {
    return 'blocked'
  }
  if (changeRequest.draft) return 'draft'
  if (changeRequest.mergeQueue === 'removed') return 'merge_queue_removed'
  if (changeRequest.checks === 'pending') return 'checks_pending'
  if (changeRequest.mergeQueue === 'awaiting_checks' || changeRequest.mergeQueue === 'checking') {
    return 'merge_queue_checking'
  }
  if (changeRequest.mergeQueue === 'queued') {
    return 'merge_queue_queued'
  }
  if (changeRequest.mergeQueue === 'locked') return 'merge_queue_locked'
  if (changeRequest.mergeStateStatus === 'behind') return 'behind'
  if (changeRequest.mergeStateStatus === 'unstable') return 'unstable'
  if (changeRequest.mergeStateStatus === 'has_hooks') return 'has_hooks'
  if (
    changeRequest.checks === 'success' &&
    (changeRequest.mergeStateStatus === 'clean' || changeRequest.mergeability === 'mergeable')
  ) {
    return 'checks_passed'
  }
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
  t: TFunction<'common'>,
  customPrompt = ''
): string {
  const status = changeRequestVisualStatus(changeRequest)
  const details = [
    t('workbench.change_request_repair_intro', { title: taskTitle, number: changeRequest.number }),
    t('workbench.change_request_repair_status', {
      status: t(`workbench.change_request_status_${status}`),
    }),
    changeRequest.mergeQueueReason
      ? t('workbench.change_request_repair_queue_reason', {
          reason: changeRequest.mergeQueueReason,
        })
      : '',
    t('workbench.change_request_repair_url', { url: changeRequest.url }),
    t('workbench.change_request_repair_instructions'),
    t('workbench.change_request_repair_reuse'),
    customPrompt.trim(),
  ]
  return details.filter(Boolean).join('\n')
}

export function changeRequestRepairEventKey(changeRequest: ChangeRequest): string {
  return [
    changeRequest.provider,
    changeRequest.url,
    changeRequest.headBranch ?? '',
    changeRequest.headSha ?? '',
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
