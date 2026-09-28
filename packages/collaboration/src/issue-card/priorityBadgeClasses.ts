import type { CollaborationPriority } from '../types'

export const collaborationIssueCardPriorityClasses: Record<CollaborationPriority, string> = {
  none: 'bg-muted text-text-secondary',
  low: 'bg-muted text-text-secondary',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  high: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  urgent: 'bg-red-500/10 text-red-600 dark:text-red-400',
}
