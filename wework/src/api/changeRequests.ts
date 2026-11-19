import type { ResourceObservation } from '@/features/workbench/resourceObservation'
import type { ResourceEventFact } from '@/lib/runtime-connection-events'
import type {
  ChangeRequest,
  ChangeRequestLookupState,
  ChangeRequestMergeQueueState,
  ChangeRequestProvider,
} from '@/types/environment'
import { parseChangeRequest } from './environment'

export interface TaskChangeRequestTarget {
  deviceId: string
  taskId: string
  workspacePath: string
  remoteUrl: string
  branch: string
  changeRequestUrl?: string
}

export interface TaskChangeRequestSnapshot {
  target: TaskChangeRequestTarget
  changeRequest: ChangeRequest | null
  fetchedAt: string
  provider?: ChangeRequestProvider
  lookupState?: ChangeRequestLookupState
  stale?: boolean
  error?: string | null
  observation?: ResourceObservation
  resourceEvents?: ResourceEventFact[]
}

interface MergeQueueEvent {
  type: 'added' | 'removed'
  createdAt: string
  reason?: string | null
}

function mergeQueueState(value: string): ChangeRequestMergeQueueState {
  switch (value.toUpperCase()) {
    case 'QUEUED':
    case 'LOCKED':
      return 'queued'
    case 'AWAITING_CHECKS':
      return 'checking'
    case 'MERGEABLE':
      return 'mergeable'
    case 'UNMERGEABLE':
      return 'conflicting'
    default:
      return 'unknown'
  }
}

function removedQueueState(reason: string): ChangeRequestMergeQueueState {
  const normalized = reason.toLowerCase()
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timed_out'
  if (
    normalized.includes('conflict') ||
    normalized.includes('unmergeable') ||
    normalized.includes('merge conflict')
  ) {
    return 'conflicting'
  }
  if (
    normalized.includes('fail') ||
    normalized.includes('check') ||
    normalized.includes('required status')
  ) {
    return 'failed'
  }
  return 'removed'
}

function queueEvents(value: unknown): MergeQueueEvent[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const timeline = record.timelineItems
  if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) return []
  const nodes = (timeline as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap<MergeQueueEvent>(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return []
    const event = node as Record<string, unknown>
    const createdAt = typeof event.createdAt === 'string' ? event.createdAt : ''
    if (!createdAt) return []
    if (event.__typename === 'AddedToMergeQueueEvent') {
      return [{ type: 'added' as const, createdAt }]
    }
    if (event.__typename === 'RemovedFromMergeQueueEvent') {
      return [
        {
          type: 'removed' as const,
          createdAt,
          reason: typeof event.reason === 'string' ? event.reason : null,
        },
      ]
    }
    return []
  })
}

function latestHeadCommitAt(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const commits = (value as Record<string, unknown>).commits
  if (!commits || typeof commits !== 'object' || Array.isArray(commits)) return null
  const nodes = (commits as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return null
  const node = nodes.at(-1)
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const commit = (node as Record<string, unknown>).commit
  if (!commit || typeof commit !== 'object' || Array.isArray(commit)) return null
  const committedDate = (commit as Record<string, unknown>).committedDate
  if (typeof committedDate !== 'string') return null
  const timestamp = Date.parse(committedDate)
  return Number.isNaN(timestamp) ? null : timestamp
}

function applyMergeQueueDetails(changeRequest: ChangeRequest, value: unknown): ChangeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return changeRequest
  const record = value as Record<string, unknown>
  const entry = record.mergeQueueEntry
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const state = (entry as Record<string, unknown>).state
    return {
      ...changeRequest,
      mergeQueue: typeof state === 'string' ? mergeQueueState(state) : 'queued',
      mergeQueueReason: null,
    }
  }
  const latest = queueEvents(record).sort(
    (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
  )[0]
  if (latest?.type !== 'removed') {
    return { ...changeRequest, mergeQueue: 'not_queued', mergeQueueReason: null }
  }
  const removedAt = Date.parse(latest.createdAt)
  const headCommitAt = latestHeadCommitAt(record)
  if (headCommitAt !== null && !Number.isNaN(removedAt) && headCommitAt > removedAt) {
    return { ...changeRequest, mergeQueue: 'not_queued', mergeQueueReason: null }
  }
  const reason = latest.reason?.trim() || ''
  return {
    ...changeRequest,
    mergeQueue: removedQueueState(reason),
    mergeQueueReason: reason || null,
  }
}

function applyGithubDetails(changeRequest: ChangeRequest, value: unknown): ChangeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return changeRequest
  const details = value as Record<string, unknown>
  const parsed = parseChangeRequest('github', {
    ...details,
    number: changeRequest.number,
    url: changeRequest.url,
    title: changeRequest.title,
    headRefName: changeRequest.headBranch,
  })
  return applyMergeQueueDetails(
    parsed
      ? {
          ...changeRequest,
          state: parsed.state,
          draft: parsed.draft,
          checks: parsed.checks,
          mergeability: parsed.mergeability,
          updatedAt: parsed.updatedAt ?? changeRequest.updatedAt,
          headSha: parsed.headSha ?? changeRequest.headSha,
        }
      : changeRequest,
    details
  )
}

export function observedChangeRequest(
  provider: ChangeRequestProvider,
  data: unknown,
  url: string
): ChangeRequest | null {
  const request = parseChangeRequest(provider, data)
  if (!request || request.url !== url) return null
  return provider === 'github' ? applyGithubDetails(request, data) : request
}

export function linkedChangeRequestTarget(
  deviceId: string,
  value: string
): TaskChangeRequestTarget | null {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    const match =
      url.pathname.match(/^(\/[^/]+\/[^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/) ??
      url.pathname.match(/^(\/.+?)\/-\/merge_requests\/([1-9]\d*)(?:\/.*)?$/)
    if (!match || !Number.isSafeInteger(Number(match[2]))) return null
    const gitlab = url.pathname.includes('/-/merge_requests/')
    const changeRequestUrl = `${url.origin}${match[1]}${gitlab ? '/-/merge_requests/' : '/pull/'}${match[2]}`
    return {
      deviceId,
      taskId: changeRequestUrl,
      workspacePath: '',
      remoteUrl: `${url.origin}${match[1]}`,
      branch: '',
      changeRequestUrl,
    }
  } catch {
    return null
  }
}
