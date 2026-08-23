import type { CloudLoopItem, CloudMyWorkItem } from '@/api/deliveries'
import { isExecutionActive } from './executionStatus'

export type MyWorkGroupKey = 'approval' | 'action' | 'running' | 'review' | 'done'

export function isLoopItemExecutionActive(
  item: Pick<CloudLoopItem, 'status' | 'execution_state'>
): boolean {
  return item.status === 'in_progress' || isExecutionActive(item.execution_state)
}

export function isMyWorkExecutionActive(item: CloudMyWorkItem): boolean {
  if (item.execution_state != null) return isLoopItemExecutionActive(item)
  // A manually-created Runtime task has no queue execution attempt. Its task
  // binding remains authoritative for that separate path.
  return item.has_active_task && item.status === 'in_progress'
}

// Single primary group used by the list / calendar / timeline views, where an
// item needs exactly one status.
export function myWorkGroupOf(item: CloudMyWorkItem): MyWorkGroupKey {
  if (item.execution_state === 'waiting_approval' && item.can_approve === true) return 'approval'
  if (item.status === 'completed') return 'done'
  if (item.status === 'in_review') return 'review'
  if (isMyWorkExecutionActive(item)) return 'running'
  return 'action'
}
