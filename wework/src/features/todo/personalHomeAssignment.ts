import type { WorkspaceMyWorkItem } from '@wegent/collaboration'

/** Age belongs to the current human assignment, never the Issue's creation date. */
export function personalHomeAssignmentAt(
  issue: WorkspaceMyWorkItem,
  viewers: readonly (string | number)[]
): string | null {
  if (
    issue.assignee_user_id == null ||
    !viewers.some(id => String(id) === String(issue.assignee_user_id))
  )
    return null
  const last = issue.assignment_history?.at(-1)
  const raw =
    issue.assignment_context?.created_at ??
    (last?.to_type === 'user' && String(last.to_id) === String(issue.assignee_user_id)
      ? last.at
      : null)
  if (!raw) return null
  const instant = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`
  return Number.isFinite(Date.parse(instant)) ? instant : null
}

export function personalHomeAssignmentDuration(
  at: string,
  locale: string,
  now = Date.now()
): string {
  const minutes = Math.max(1, Math.floor((now - Date.parse(at)) / 60_000))
  const [unit, count] =
    minutes >= 1440
      ? (['day', Math.floor(minutes / 1440)] as const)
      : minutes >= 60
        ? (['hour', Math.floor(minutes / 60)] as const)
        : (['minute', minutes] as const)
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(count)
}
