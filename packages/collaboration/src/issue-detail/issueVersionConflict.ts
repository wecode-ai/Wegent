import { hasVersionConflictCode } from '../versionConflict'

export function isIssueVersionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const source = error as Record<string, unknown>
  return (
    hasVersionConflictCode(error) ||
    source.message === 'TODO changed' ||
    source.message === 'Issue changed; refresh before continuing'
  )
}
