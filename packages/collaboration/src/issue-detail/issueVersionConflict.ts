export function isIssueVersionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const source = error as Record<string, unknown>
  const detail =
    source.detail && typeof source.detail === 'object'
      ? (source.detail as Record<string, unknown>)
      : {}
  return (
    (detail.code ?? source.errorCode ?? source.code) === 'version_conflict' ||
    source.message === 'TODO changed' ||
    source.message === 'Issue changed; refresh before continuing'
  )
}
