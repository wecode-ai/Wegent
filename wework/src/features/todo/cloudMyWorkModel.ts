import type { CloudMyWorkItem } from '@/api/deliveries'

export type MyWorkGroupKey = 'approval' | 'action' | 'running' | 'review' | 'done'

// Single primary group used by the list / calendar / timeline views, where an
// item needs exactly one status.
export function myWorkGroupOf(item: CloudMyWorkItem): MyWorkGroupKey {
  if (item.execution_state === 'pending_approval' && item.can_approve === true) return 'approval'
  if (item.status === 'completed') return 'done'
  if (item.status === 'in_review') return 'review'
  if (item.has_active_task && item.status === 'in_progress') return 'running'
  return 'action'
}
