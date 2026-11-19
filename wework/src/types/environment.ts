import type { ResourceObservation } from '@/features/workbench/resourceObservation'

export type ChangeRequestProvider = 'github' | 'gitlab'
export type ChangeRequestState = 'open' | 'closed' | 'merged'
export type ChangeRequestChecksState = 'unknown' | 'pending' | 'success' | 'failure'
export type ChangeRequestMergeability = 'unknown' | 'mergeable' | 'conflicting'
export type ChangeRequestMergeStateStatus =
  | 'clean'
  | 'blocked'
  | 'behind'
  | 'unstable'
  | 'has_hooks'
  | 'dirty'
  | 'unknown'
export type ChangeRequestReviewDecision = 'approved' | 'changes_requested' | 'review_required'
export type ChangeRequestMergeQueueState =
  | 'unknown'
  | 'queued'
  | 'awaiting_checks'
  | 'checking'
  | 'mergeable'
  | 'unmergeable'
  | 'locked'
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
  mergeStateStatus?: ChangeRequestMergeStateStatus
  reviewDecision?: ChangeRequestReviewDecision | null
  mergeQueue: ChangeRequestMergeQueueState
  mergeQueueReason?: string | null
  headBranch?: string | null
  headSha?: string | null
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
  executionDeviceId?: string
  deviceId?: string
  workspacePath?: string
  workspaceRoots?: string[]
  branchName?: string
  createPullRequestUrl?: string
  changeRequest?: ChangeRequestLookup
  changeRequestObservation?: ResourceObservation
  error?: string
  loading?: boolean
  branchLoading?: boolean
}
