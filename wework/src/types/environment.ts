export type ChangeRequestProvider = 'github' | 'gitlab'
export type ChangeRequestState = 'open' | 'closed' | 'merged'
export type ChangeRequestChecksState = 'unknown' | 'pending' | 'success' | 'failure'
export type ChangeRequestMergeability = 'unknown' | 'mergeable' | 'conflicting'
export type ChangeRequestMergeQueueState =
  | 'unknown'
  | 'queued'
  | 'checking'
  | 'mergeable'
  | 'conflicting'
  | 'failed'
  | 'timed_out'
  | 'removed'
  | 'not_queued'
export type ChangeRequestLookupState =
  | 'found'
  | 'not_found'
  | 'unavailable'
  | 'unauthenticated'
  | 'error'

export interface ChangeRequest {
  provider: ChangeRequestProvider
  number: number
  url: string
  title: string
  state: ChangeRequestState
  draft: boolean
  checks: ChangeRequestChecksState
  mergeability: ChangeRequestMergeability
  mergeQueue: ChangeRequestMergeQueueState
  mergeQueueReason?: string | null
  headBranch?: string | null
  updatedAt?: string | null
}

export interface ChangeRequestLookup {
  provider: ChangeRequestProvider
  state: ChangeRequestLookupState
  changeRequest?: ChangeRequest
}

export interface EnvironmentInfo {
  additions: string
  deletions: string
  executionTarget: 'local' | 'cloud' | 'remote'
  isGitRepository?: boolean
  deviceId?: string
  workspacePath?: string
  workspaceRoots?: string[]
  branchName?: string
  createPullRequestUrl?: string
  changeRequest?: ChangeRequestLookup
  error?: string
  loading?: boolean
  branchLoading?: boolean
}
