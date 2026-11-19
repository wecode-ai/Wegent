import type { CollaborationIssue, CollaborationStatus } from '../types'

const statusClasses: Record<CollaborationStatus['color'], string> = {
  gray: 'bg-zinc-500',
  blue: 'bg-blue-500',
  orange: 'bg-amber-500',
  purple: 'bg-violet-500',
  green: 'bg-emerald-500',
  red: 'bg-red-500',
}

export const statusSurfaceClasses: Record<
  CollaborationStatus['color'],
  string
> = {
  gray: 'bg-zinc-500/10',
  blue: 'bg-blue-500/10',
  orange: 'bg-amber-500/10',
  purple: 'bg-violet-500/10',
  green: 'bg-emerald-500/10',
  red: 'bg-red-500/10',
}

export function statusColor(
  statuses: readonly CollaborationStatus[],
  issue: CollaborationIssue,
): CollaborationStatus['color'] {
  return (
    statuses.find((candidate) => candidate.id === issue.status)?.color ?? 'gray'
  )
}

export function statusClass(
  statuses: readonly CollaborationStatus[],
  issue: CollaborationIssue,
): string {
  return statusClasses[statusColor(statuses, issue)]
}

export function statusLabel(
  statuses: readonly CollaborationStatus[],
  issue: CollaborationIssue,
): string {
  return (
    statuses.find((candidate) => candidate.id === issue.status)?.name ??
    issue.status
  )
}
