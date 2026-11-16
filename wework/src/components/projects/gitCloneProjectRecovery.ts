export type GitCloneFailureReason =
  | 'executor-offline'
  | 'executor-not-found'
  | 'clone-failed'
  | 'open-failed'

export function gitCloneFailureReason(
  error: unknown,
  stage: 'clone' | 'open'
): GitCloneFailureReason {
  if (error instanceof Error && error.message.startsWith('executor-not-found:')) {
    return 'executor-not-found'
  }
  if (error instanceof Error && error.message.includes('executor-offline:')) {
    return 'executor-offline'
  }
  return stage === 'clone' ? 'clone-failed' : 'open-failed'
}

export function isGitCloneDeviceMissing(operation: {
  failureReason?: GitCloneFailureReason
  error?: string
}): boolean {
  return (
    operation.failureReason === 'executor-not-found' ||
    operation.error?.startsWith('executor-not-found:') === true
  )
}
