import type { DeviceCommandResponse } from '@/types/api'
import type {
  ChangeRequest,
  ChangeRequestMergeQueueState,
  ChangeRequestProvider,
} from '@/types/environment'
import {
  type DeviceCommandApi,
  outputAsArray,
  outputAsRecord,
  parseChangeRequest,
  parseGitRemote,
} from './environment'

export interface TaskChangeRequestTarget {
  deviceId: string
  taskId: string
  workspacePath: string
  remoteUrl: string
  branch: string
}

export interface TaskChangeRequestSnapshot {
  target: TaskChangeRequestTarget
  changeRequest: ChangeRequest | null
  fetchedAt: string
  stale?: boolean
  error?: string | null
}

interface RepositoryTargetGroup {
  deviceId: string
  workspacePath: string
  remoteUrl: string
  provider: ChangeRequestProvider
  owner: string
  name: string
  targets: TaskChangeRequestTarget[]
}

interface MergeQueueEvent {
  type: 'added' | 'removed'
  createdAt: string
  reason?: string | null
}

function commandError(response: DeviceCommandResponse): string {
  return response.error || response.stderr || 'Failed to query pull requests'
}

function repositoryGroup(target: TaskChangeRequestTarget): RepositoryTargetGroup | null {
  const remote = parseGitRemote(target.remoteUrl)
  if (!remote) return null
  const provider: ChangeRequestProvider | null = remote.host.includes('github')
    ? 'github'
    : remote.host.includes('gitlab')
      ? 'gitlab'
      : null
  if (!provider) return null
  const parts = remote.repoPath.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return {
    deviceId: target.deviceId,
    workspacePath: target.workspacePath,
    remoteUrl: target.remoteUrl,
    provider,
    owner: provider === 'github' ? parts[0] : parts.slice(0, -1).join('/'),
    name: parts.at(-1)!,
    targets: [target],
  }
}

function groupTargets(targets: TaskChangeRequestTarget[]): RepositoryTargetGroup[] {
  const groups = new Map<string, RepositoryTargetGroup>()
  for (const target of targets) {
    const candidate = repositoryGroup(target)
    if (!candidate) continue
    const key = `${candidate.deviceId}\0${candidate.provider}\0${candidate.remoteUrl}`
    const current = groups.get(key)
    if (current) {
      current.targets.push(target)
    } else {
      groups.set(key, candidate)
    }
  }
  return [...groups.values()]
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
        }
      : changeRequest,
    details
  )
}

function githubMergeQueueQuery(
  group: RepositoryTargetGroup,
  pullRequests: ChangeRequest[]
): string {
  const fields = pullRequests
    .map(
      (pullRequest, index) => `
        pr${index}: pullRequest(number: ${pullRequest.number}) {
          state
          isDraft
          mergedAt
          updatedAt
          mergeable
          mergeStateStatus
          statusCheckRollup { state }
          commits(last: 1) {
            nodes { commit { committedDate } }
          }
          mergeQueueEntry { state }
          timelineItems(
            last: 10
            itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]
          ) {
            nodes {
              __typename
              ... on AddedToMergeQueueEvent { createdAt }
              ... on RemovedFromMergeQueueEvent { createdAt reason }
            }
          }
        }`
    )
    .join('\n')
  return `query {
    repository(owner: ${JSON.stringify(group.owner)}, name: ${JSON.stringify(group.name)}) {
      ${fields}
    }
  }`
}

async function loadGithubMergeQueue(
  api: DeviceCommandApi,
  group: RepositoryTargetGroup,
  pullRequests: ChangeRequest[]
): Promise<ChangeRequest[]> {
  if (pullRequests.length === 0) return pullRequests
  const response = await api.executeCommand(group.deviceId, {
    command_key: 'git_github_pull_request_merge_queue_batch',
    path: group.workspacePath,
    args: ['-f', `query=${githubMergeQueueQuery(group, pullRequests)}`],
    timeout_seconds: 20,
    max_output_bytes: 256 * 1024,
  })
  if (!response.success) return pullRequests
  const repository = outputAsRecord(response.stdout)?.data
  const repositoryRecord =
    repository && typeof repository === 'object' && !Array.isArray(repository)
      ? (repository as Record<string, unknown>).repository
      : null
  if (
    !repositoryRecord ||
    typeof repositoryRecord !== 'object' ||
    Array.isArray(repositoryRecord)
  ) {
    return pullRequests
  }
  const details = repositoryRecord as Record<string, unknown>
  return pullRequests.map((pullRequest, index) =>
    applyGithubDetails(pullRequest, details[`pr${index}`])
  )
}

async function loadRepository(
  api: DeviceCommandApi,
  group: RepositoryTargetGroup
): Promise<TaskChangeRequestSnapshot[]> {
  const response = await api.executeCommand(group.deviceId, {
    command_key:
      group.provider === 'github'
        ? 'git_github_pull_requests_batch'
        : 'git_gitlab_merge_requests_batch',
    path: group.workspacePath,
    timeout_seconds: 20,
    max_output_bytes: 1024 * 1024,
  })
  if (!response.success) throw new Error(commandError(response))
  let pullRequests =
    outputAsArray(response.stdout)
      ?.map(value => parseChangeRequest(group.provider, value))
      .filter((value): value is ChangeRequest => Boolean(value)) ?? []
  const targetBranches = new Set(group.targets.map(target => target.branch))
  pullRequests = pullRequests.filter(
    pullRequest => Boolean(pullRequest.headBranch) && targetBranches.has(pullRequest.headBranch!)
  )
  if (group.provider === 'github') {
    pullRequests = await loadGithubMergeQueue(api, group, pullRequests)
  }
  const byBranch = new Map<string, ChangeRequest[]>()
  for (const pullRequest of pullRequests) {
    if (!pullRequest.headBranch) continue
    const values = byBranch.get(pullRequest.headBranch) ?? []
    values.push(pullRequest)
    byBranch.set(pullRequest.headBranch, values)
  }
  const fetchedAt = new Date().toISOString()
  return group.targets.map(target => ({
    target,
    changeRequest:
      byBranch.get(target.branch)?.sort((left, right) => {
        if (left.state === 'open' && right.state !== 'open') return -1
        if (right.state === 'open' && left.state !== 'open') return 1
        return right.number - left.number
      })[0] ?? null,
    fetchedAt,
  }))
}

export async function loadTaskChangeRequests(
  api: DeviceCommandApi,
  targets: TaskChangeRequestTarget[]
): Promise<TaskChangeRequestSnapshot[]> {
  const groups = groupTargets(targets)
  const results = await Promise.allSettled(groups.map(group => loadRepository(api, group)))
  return results.flatMap((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : groups[index].targets.map(target => ({
          target,
          changeRequest: null,
          fetchedAt: new Date().toISOString(),
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }))
  )
}
