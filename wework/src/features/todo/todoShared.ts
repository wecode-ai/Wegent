import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
export { reorderLaneItems } from '@wegent/collaboration'

export const columns: Array<{ status: CloudLoopItem['status']; label: string }> = [
  { status: 'inbox', label: '收集箱' },
  { status: 'pending', label: '待开始' },
  { status: 'in_progress', label: '进行中' },
  { status: 'in_review', label: '待确认' },
  { status: 'completed', label: '已完成' },
]

export const columnDotClasses: Record<string, string> = {
  inbox: 'bg-zinc-400',
  pending: 'bg-indigo-500',
  in_progress: 'bg-amber-500',
  in_review: 'bg-violet-500',
  completed: 'bg-emerald-500',
}

export const boardStatusColorClasses: Record<string, string> = {
  gray: 'bg-zinc-400',
  blue: 'bg-blue-500',
  orange: 'bg-amber-500',
  purple: 'bg-violet-500',
  green: 'bg-emerald-500',
  red: 'bg-red-500',
}

export const memberAvatarClasses = [
  'bg-gradient-to-br from-indigo-400 to-indigo-500',
  'bg-gradient-to-br from-emerald-400 to-emerald-500',
  'bg-gradient-to-br from-amber-400 to-amber-500',
]

export const priorityBadgeClasses: Record<CloudLoopItem['priority'], string> = {
  none: 'bg-muted text-text-secondary',
  low: 'bg-muted text-text-secondary',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  urgent: 'bg-red-500/10 text-red-600 dark:text-red-400',
}

// Resolves a user id to the project member display name; returns null when
// the user is not (or no longer) a member of the project.
export function memberNameById(
  members: CloudProjectMember[],
  userId: number | null
): string | null {
  if (userId === null) return null
  return members.find(member => member.user_id === userId)?.user_name ?? null
}
