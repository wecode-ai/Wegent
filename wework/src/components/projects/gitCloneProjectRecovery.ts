import type { GitCloneProjectOperation } from '@/types/api'

export function gitCloneFailureReason(
  error: unknown,
  stage: 'clone' | 'open'
): NonNullable<GitCloneProjectOperation['failureReason']> {
  if (error instanceof Error && error.message.startsWith('executor-not-found:')) {
    return 'executor-not-found'
  }
  if (error instanceof Error && error.message.includes('executor-offline:')) {
    return 'executor-offline'
  }
  return stage === 'clone' ? 'clone-failed' : 'open-failed'
}

export function isGitCloneDeviceMissing(operation: GitCloneProjectOperation): boolean {
  return (
    operation.failureReason === 'executor-not-found' ||
    operation.error?.startsWith('executor-not-found:') === true
  )
}
