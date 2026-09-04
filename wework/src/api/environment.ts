import type { DeviceCommandRequest, DeviceCommandResponse, ProjectWithTasks } from '@/types/api'
import type {
  ChangeRequest,
  ChangeRequestChecksState,
  ChangeRequestLookup,
  ChangeRequestLookupState,
  ChangeRequestMergeability,
  ChangeRequestMergeQueueState,
  ChangeRequestProvider,
  ChangeRequestState,
  EnvironmentInfo,
} from '@/types/environment'
import { getAppPreferences } from '@/desktop/appPreferences'
import type { WorkspaceTarget } from '@/types/workspace-files'
import {
  configuredWorkspacePath,
  executionDeviceId,
  resolveProjectWorkspacePath,
} from '@/lib/project-workspace'

export interface DeviceCommandApi {
  executeCommand(deviceId: string, data: DeviceCommandRequest): Promise<DeviceCommandResponse>
}

type EnvironmentWorkspaceTarget = Pick<WorkspaceTarget, 'deviceId' | 'path'> &
  Partial<Pick<WorkspaceTarget, 'source'>>

interface GitRemoteParts {
  host: string
  repoPath: string
}

const EMPTY_ENVIRONMENT_INFO: EnvironmentInfo = {
  additions: '+0',
  deletions: '-0',
  executionTarget: 'local',
}
const INVALID_BRANCH_CHARACTERS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\', ']'])
const ENVIRONMENT_INFO_CACHE_TTL_MS = 1500
let environmentLoadSequence = 0

interface EnvironmentLoadDiagnostics {
  loadId: number
  startedAt: number
}

export type EnvironmentDiffMode = 'branch' | 'unstaged' | 'staged' | 'commit'

export interface EnvironmentInfoLoadOptions {
  changeRequestStatusEnabled?: boolean
  force?: boolean
  onPartialInfo?: (info: EnvironmentInfo) => void
}

const ENVIRONMENT_DIFF_COMMANDS: Record<EnvironmentDiffMode, string> = {
  branch: 'git_branch_diff',
  unstaged: 'git_diff_unstaged',
  staged: 'git_diff_staged',
  commit: 'git_diff_last_commit',
}
const GENERATED_COMMIT_MESSAGE_COMMAND = 'git_generate_commit_message'
const NO_CHANGES_TO_COMMIT_MESSAGE = 'No changes to commit'

type EnvironmentInfoCacheEntry = {
  expiresAt: number
  promise: Promise<EnvironmentInfo>
  settled: boolean
  value?: EnvironmentInfo
  partialState: {
    info?: EnvironmentInfo
    listeners: Set<(info: EnvironmentInfo) => void>
  }
}

const environmentInfoCaches = new WeakMap<
  DeviceCommandApi,
  Map<string, EnvironmentInfoCacheEntry>
>()

function environmentNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function logEnvironmentLoad(
  diagnostics: EnvironmentLoadDiagnostics,
  stage: string,
  details: Record<string, unknown> = {}
): void {
  console.info('[Wework] Environment load', {
    loadId: diagnostics.loadId,
    stage,
    elapsedMs: Math.round(environmentNow() - diagnostics.startedAt),
    ...details,
  })
}

async function traceEnvironmentOperation<T>(
  diagnostics: EnvironmentLoadDiagnostics,
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = environmentNow()
  logEnvironmentLoad(diagnostics, `${stage}:started`)
  try {
    const result = await operation()
    logEnvironmentLoad(diagnostics, `${stage}:completed`, {
      durationMs: Math.round(environmentNow() - startedAt),
    })
    return result
  } catch (error) {
    logEnvironmentLoad(diagnostics, `${stage}:failed`, {
      durationMs: Math.round(environmentNow() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function outputAsString(output: DeviceCommandResponse['stdout']): string {
  if (typeof output === 'string') {
    return output
  }
  if (Array.isArray(output) && output.every(item => typeof item === 'string')) {
    return output.join('\n')
  }
  throw new Error('Expected text stdout from device command')
}

export function outputAsRecord(
  output: DeviceCommandResponse['stdout']
): Record<string, unknown> | null {
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return output && typeof output === 'object' && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : null
}

export function outputAsArray(output: DeviceCommandResponse['stdout']): unknown[] | null {
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return Array.isArray(output) ? output : null
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') {
      return value
    }
  }
  return ''
}

function booleanValue(record: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') {
      return value
    }
  }
  return false
}

function numberValue(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return 0
}

function normalizeChangeRequestState(value: string): ChangeRequestState {
  const state = value.toLowerCase()
  if (state === 'merged') return 'merged'
  if (state === 'closed') return 'closed'
  return 'open'
}

function normalizeChecksState(statuses: string[]): ChangeRequestChecksState {
  if (statuses.length === 0) return 'unknown'
  const normalized = statuses.map(status => status.toLowerCase())
  if (
    normalized.some(status =>
      [
        'failure',
        'failed',
        'error',
        'cancelled',
        'canceled',
        'timed_out',
        'action_required',
        'startup_failure',
        'stale',
      ].includes(status)
    )
  ) {
    return 'failure'
  }
  if (
    normalized.some(status =>
      [
        'pending',
        'running',
        'in_progress',
        'queued',
        'created',
        'waiting_for_resource',
        'preparing',
        'scheduled',
        'waiting',
      ].includes(status)
    )
  ) {
    return 'pending'
  }
  if (
    normalized.every(status =>
      ['success', 'successful', 'passed', 'skipped', 'neutral', 'manual'].includes(status)
    )
  ) {
    return 'success'
  }
  return 'unknown'
}

function normalizeMergeability(
  provider: ChangeRequestProvider,
  record: Record<string, unknown>
): ChangeRequestMergeability {
  if (provider === 'github') {
    const mergeable = stringValue(record, 'mergeable').toLowerCase()
    const mergeStateStatus = stringValue(record, 'mergeStateStatus').toLowerCase()
    if (mergeable === 'conflicting' || mergeStateStatus === 'dirty') return 'conflicting'
    if (mergeable === 'mergeable') return 'mergeable'
    return 'unknown'
  }

  if (booleanValue(record, 'has_conflicts', 'hasConflicts')) return 'conflicting'
  const mergeStatus = stringValue(
    record,
    'detailed_merge_status',
    'detailedMergeStatus',
    'merge_status',
    'mergeStatus'
  ).toLowerCase()
  if (mergeStatus.includes('conflict') || mergeStatus === 'cannot_be_merged') {
    return 'conflicting'
  }
  if (mergeStatus === 'mergeable' || mergeStatus === 'can_be_merged') return 'mergeable'
  return 'unknown'
}

function githubCheckStatuses(record: Record<string, unknown>): string[] {
  const rollup = record.statusCheckRollup
  if (rollup && typeof rollup === 'object' && !Array.isArray(rollup)) {
    return [stringValue(rollup as Record<string, unknown>, 'state')].filter(Boolean)
  }
  if (!Array.isArray(rollup)) return []
  const latestChecks = new Map<
    string,
    { check: Record<string, unknown>; startedAt: number; index: number }
  >()

  rollup.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return
    const check = item as Record<string, unknown>
    const name = stringValue(check, 'name', 'context')
    const workflow =
      check.workflow && typeof check.workflow === 'object' && !Array.isArray(check.workflow)
        ? (check.workflow as Record<string, unknown>)
        : null
    const workflowName = stringValue(check, 'workflowName') || (workflow?.name as string) || ''
    const startedAtValue = stringValue(check, 'startedAt', 'completedAt', 'createdAt')
    const startedAt = Date.parse(startedAtValue)
    const canIdentifyRun = name && Number.isFinite(startedAt)
    const identity = canIdentifyRun ? `${workflowName}\0${name}` : `unidentified\0${index}`
    const previous = latestChecks.get(identity)

    if (!previous || startedAt >= previous.startedAt) {
      latestChecks.set(identity, {
        check,
        startedAt: canIdentifyRun ? startedAt : 0,
        index,
      })
    }
  })

  return Array.from(latestChecks.values())
    .sort((left, right) => left.index - right.index)
    .flatMap(({ check }) =>
      [stringValue(check, 'conclusion') || stringValue(check, 'state', 'status')].filter(Boolean)
    )
}

function gitlabCheckStatuses(record: Record<string, unknown>): string[] {
  const pipeline = record.head_pipeline ?? record.headPipeline ?? record.pipeline
  if (!pipeline || typeof pipeline !== 'object' || Array.isArray(pipeline)) return []
  return [stringValue(pipeline as Record<string, unknown>, 'status')].filter(Boolean)
}

function githubMergeQueueState(value: unknown): ChangeRequestMergeQueueState {
  const response =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  const data =
    response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : null
  const resource =
    data?.resource && typeof data.resource === 'object' && !Array.isArray(data.resource)
      ? (data.resource as Record<string, unknown>)
      : null
  if (!resource || !Object.hasOwn(resource, 'mergeQueueEntry')) return 'unknown'
  return resource.mergeQueueEntry ? 'queued' : 'not_queued'
}

export function parseChangeRequest(
  provider: ChangeRequestProvider,
  value: unknown
): ChangeRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const number = numberValue(record, 'number', 'iid')
  const url = stringValue(record, 'url', 'html_url', 'web_url', 'webUrl')
  if (!number || !url) return null
  const head =
    record.head && typeof record.head === 'object' && !Array.isArray(record.head)
      ? (record.head as Record<string, unknown>)
      : null
  const mergedAt = stringValue(record, 'mergedAt', 'merged_at')
  const state = mergedAt ? 'merged' : normalizeChangeRequestState(stringValue(record, 'state'))
  const headBranch =
    stringValue(record, 'headRefName', 'source_branch', 'sourceBranch') ||
    (head ? stringValue(head, 'ref') : '')
  const updatedAt = stringValue(record, 'updatedAt', 'updated_at')

  return {
    provider,
    number,
    url,
    title: stringValue(record, 'title'),
    state,
    draft: booleanValue(record, 'isDraft', 'draft'),
    checks: normalizeChecksState(
      provider === 'github' ? githubCheckStatuses(record) : gitlabCheckStatuses(record)
    ),
    mergeability: normalizeMergeability(provider, record),
    mergeQueue: 'unknown',
    ...(headBranch ? { headBranch } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function classifyChangeRequestCommandError(
  response: DeviceCommandResponse
): ChangeRequestLookupState {
  const message = [response.error, response.stderr].filter(Boolean).join('\n').toLowerCase()
  if (
    message.includes('not found') ||
    message.includes('no such file') ||
    message.includes('executable file')
  ) {
    return 'unavailable'
  }
  if (
    message.includes('auth') ||
    message.includes('login') ||
    message.includes('token') ||
    message.includes('unauthorized')
  ) {
    return 'unauthenticated'
  }
  return 'error'
}

async function loadChangeRequest(
  api: DeviceCommandApi,
  deviceId: string,
  path: string,
  remoteUrl: string,
  branchName: string,
  diagnostics: EnvironmentLoadDiagnostics,
  onInitialLookup?: (lookup: ChangeRequestLookup) => void
): Promise<ChangeRequestLookup | undefined> {
  const remote = parseGitRemote(remoteUrl)
  const branch = branchName.trim()
  if (!remote || !branch) return undefined

  const provider: ChangeRequestProvider | undefined = remote.host.includes('github')
    ? 'github'
    : remote.host.includes('gitlab')
      ? 'gitlab'
      : undefined
  if (!provider) return undefined

  let response: DeviceCommandResponse
  try {
    response = await traceEnvironmentOperation(diagnostics, 'change_request', () =>
      api.executeCommand(deviceId, {
        command_key:
          provider === 'github' ? 'git_github_pull_requests' : 'git_gitlab_merge_requests',
        path,
        args: [branch],
        timeout_seconds: 20,
        max_output_bytes: 256 * 1024,
      })
    )
  } catch {
    return { provider, state: 'error' }
  }
  if (!response.success) {
    return { provider, state: classifyChangeRequestCommandError(response) }
  }

  const changeRequests = outputAsArray(response.stdout)
    ?.map(value => parseChangeRequest(provider, value))
    .filter((value): value is ChangeRequest => Boolean(value))
    .sort((left, right) => {
      if (left.state === 'open' && right.state !== 'open') return -1
      if (right.state === 'open' && left.state !== 'open') return 1
      return right.number - left.number
    })
  const changeRequest = changeRequests?.[0]
  if (!changeRequest) {
    return { provider, state: 'not_found' }
  }

  onInitialLookup?.({
    provider,
    state: 'found',
    changeRequest: { ...changeRequest },
  })

  if (provider === 'github' && changeRequest.state === 'open') {
    try {
      const queueResponse = await traceEnvironmentOperation(diagnostics, 'merge_queue', () =>
        api.executeCommand(deviceId, {
          command_key: 'git_github_pull_request_merge_queue',
          path,
          args: ['-F', `url=${changeRequest.url}`],
          timeout_seconds: 20,
          max_output_bytes: 64 * 1024,
        })
      )
      if (queueResponse.success) {
        changeRequest.mergeQueue = githubMergeQueueState(outputAsRecord(queueResponse.stdout))
      }
    } catch {
      changeRequest.mergeQueue = 'unknown'
    }
  }

  return { provider, state: 'found', changeRequest }
}

function environmentInfoCacheKey(
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null
): string | null {
  const deviceId = target?.deviceId ?? (project ? executionDeviceId(project) : undefined)
  if (!deviceId) {
    return null
  }

  const config = project?.config
  const workspace = config?.workspace
  return JSON.stringify({
    projectId: project?.id ?? null,
    deviceId,
    path: target?.path ?? null,
    source: target?.source ?? 'project',
    executionTarget: config?.execution?.targetType ?? 'local',
    workspaceSource: workspace?.source,
    workspacePath: project ? configuredWorkspacePath(project) : null,
  })
}

function cloneEnvironmentInfo(info: EnvironmentInfo): EnvironmentInfo {
  return { ...info }
}

function getEnvironmentInfoCache(api: DeviceCommandApi): Map<string, EnvironmentInfoCacheEntry> {
  let cache = environmentInfoCaches.get(api)
  if (!cache) {
    cache = new Map<string, EnvironmentInfoCacheEntry>()
    environmentInfoCaches.set(api, cache)
  }
  return cache
}

async function resolveProjectWorkspaceRoot(
  api: DeviceCommandApi,
  deviceId: string
): Promise<string> {
  const response = await api.executeCommand(deviceId, {
    command_key: 'project_workspace_root',
    timeout_seconds: 10,
    max_output_bytes: 4096,
  })
  if (!response.success) {
    throw new Error(response.error || response.stderr || 'Failed to resolve project workspace root')
  }
  const root = outputAsString(response.stdout).trim()
  if (!root) {
    throw new Error('Project workspace root is empty')
  }
  return root
}

async function workspacePath(
  api: DeviceCommandApi,
  deviceId: string,
  project: ProjectWithTasks
): Promise<string | undefined> {
  return resolveProjectWorkspacePath(project, deviceId, {
    getProjectWorkspaceRoot: targetDeviceId => resolveProjectWorkspaceRoot(api, targetDeviceId),
  })
}

function validateBranchName(branchName: string): void {
  const components = branchName.split('/')
  const invalidComponent = components.some(
    component => !component || component.startsWith('.') || component.endsWith('.lock')
  )
  const invalidCharacter = Array.from(branchName).some(character => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127 || INVALID_BRANCH_CHARACTERS.has(character)
  })

  if (
    branchName === '@' ||
    branchName.startsWith('-') ||
    branchName.endsWith('.') ||
    branchName.includes('..') ||
    branchName.includes('@{') ||
    branchName.includes('//') ||
    invalidCharacter ||
    invalidComponent
  ) {
    throw new Error('Invalid branch name')
  }
}

export function parseGitShortStat(value: string): Pick<EnvironmentInfo, 'additions' | 'deletions'> {
  // Handle "N file(s) pending" format (no-commit repos with pending files)
  const pendingMatch = value.match(/(\d+)\s+file\(s\)\s+pending/)
  if (pendingMatch) {
    return {
      additions: `+${pendingMatch[1]}`,
      deletions: '-0',
    }
  }

  const additionsMatch = value.match(/(\d+)\s+insertions?\(\+\)/)
  const deletionsMatch = value.match(/(\d+)\s+deletions?\(-\)/)

  return {
    additions: `+${additionsMatch?.[1] ?? '0'}`,
    deletions: `-${deletionsMatch?.[1] ?? '0'}`,
  }
}

function porcelainHasTrackedChanges(lines: string[]): boolean {
  // Porcelain entries that modify, delete, rename or copy tracked files
  // (index or worktree column) imply a commit baseline exists. Untracked
  // (`??`) and staged additions (`A `) alone also appear in a repository that
  // has no commit yet, so they cannot distinguish the two cases by themselves.
  return lines.some(line => /[MDRC]/.test(line.slice(0, 1)) || /[MDRC]/.test(line.slice(1, 2)))
}

export function parseGitRemote(remoteUrl: string): GitRemoteParts | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '')
  if (!trimmed) {
    return null
  }

  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/)
  if (sshMatch) {
    return {
      host: sshMatch[1],
      repoPath: sshMatch[2],
    }
  }

  try {
    const url = new URL(trimmed)
    const host = url.protocol === 'ssh:' || url.protocol === 'git+ssh:' ? url.hostname : url.host
    return {
      host,
      repoPath: url.pathname.replace(/^\/+/, ''),
    }
  } catch {
    return null
  }
}

export function buildPullRequestUrl(remoteUrl: string, branchName: string): string | undefined {
  const remote = parseGitRemote(remoteUrl)
  const branch = branchName.trim()
  if (!remote || !branch) {
    return undefined
  }

  const encodedBranch = encodeURIComponent(branch)
  if (remote.host.includes('github')) {
    return `https://${remote.host}/${remote.repoPath}/compare/${encodedBranch}?expand=1`
  }

  if (remote.host.includes('gitlab')) {
    const params = new URLSearchParams()
    params.set('merge_request[source_branch]', branch)
    return `https://${remote.host}/${remote.repoPath}/-/merge_requests/new?${params.toString()}`
  }

  return undefined
}

export async function workspaceHasUncommittedChanges(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<boolean> {
  const porcelain = await runGitCommand(api, deviceId, 'git_status_porcelain', path, {
    maxOutputBytes: 64 * 1024,
  })
  return porcelain.length > 0
}

export async function removeGitWorktree(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<void> {
  await runGitCommand(api, deviceId, 'git_worktree_remove', path, {
    args: [path, path],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}

function prioritizeBranches(
  branches: string[],
  preferredBranches: Array<string | null | undefined>
): string[] {
  const preferred = preferredBranches
    .map(branch => branch?.trim())
    .filter((branch): branch is string => Boolean(branch))

  const uniqueBranches = [...new Set(branches)].filter(Boolean)
  const preferredSet = new Set(preferred)
  const orderedPreferred = preferred.filter(branch => uniqueBranches.includes(branch))
  const remaining = uniqueBranches.filter(branch => !preferredSet.has(branch))
  return [...orderedPreferred, ...remaining]
}

async function runGitCommand(
  api: DeviceCommandApi,
  deviceId: string,
  commandKey: string,
  path: string,
  options: {
    args?: string[]
    timeoutSeconds?: number
    maxOutputBytes?: number
  } = {}
): Promise<string> {
  const request: DeviceCommandRequest = {
    command_key: commandKey,
    path,
    timeout_seconds: options.timeoutSeconds ?? 10,
    max_output_bytes: options.maxOutputBytes ?? 4096,
  }
  if (options.args) {
    request.args = options.args
  }

  const response = await api.executeCommand(deviceId, request)

  if (!response.success) {
    throw new Error(
      [response.error, response.stderr].filter(Boolean).join('\n') || `${commandKey} failed`
    )
  }

  return outputAsString(response.stdout).trim()
}

async function probeGitRepository(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<boolean> {
  const response = await api.executeCommand(deviceId, {
    command_key: 'git_is_worktree',
    path,
    args: [path],
    timeout_seconds: 10,
    max_output_bytes: 4096,
  })

  return response.success && outputAsString(response.stdout).trim() === 'true'
}

async function generateCommitMessage(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<string> {
  const response = await api.executeCommand(deviceId, {
    command_key: GENERATED_COMMIT_MESSAGE_COMMAND,
    path,
    timeout_seconds: 120,
    max_output_bytes: 8192,
  })

  if (!response.success) {
    throw new Error(response.error || response.stderr || 'Failed to generate commit message')
  }

  const payload = outputAsRecord(response.stdout)
  if (!payload) {
    throw new Error('Failed to generate commit message')
  }
  if (payload.success === false) {
    const error = typeof payload.error === 'string' ? payload.error.trim() : ''
    throw new Error(error || 'Failed to generate commit message')
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  const firstLine = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean)
  if (!firstLine) {
    throw new Error('Failed to generate commit message')
  }
  return firstLine
}

async function loadBranchDiffShortStat(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<string | null> {
  // Compare the current branch with its merge base to the primary branch.
  // This includes committed branch changes as well as tracked worktree changes.
  try {
    return await runGitCommand(api, deviceId, 'git_branch_diff_shortstat', path)
  } catch {
    // No diff base could be resolved, most commonly because HEAD does not
    // exist yet (a repository without commits). Callers use this to decide
    // whether the pending porcelain file count is a valid substitute.
    return null
  }
}

async function commandContext(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null
): Promise<{ deviceId: string; path: string }> {
  if (target) {
    const deviceId = target.deviceId.trim()
    const path = target.path.trim()
    if (!deviceId || !path) {
      throw new Error('Workspace target device and path are required')
    }
    return { deviceId, path }
  }

  if (!project) {
    throw new Error('Project is required')
  }

  const deviceId = executionDeviceId(project)

  if (!deviceId) {
    throw new Error('Project device and workspace path are required')
  }

  const path = await workspacePath(api, deviceId, project)
  if (!path) {
    throw new Error('Project device and workspace path are required')
  }
  return { deviceId, path }
}

async function loadProjectEnvironmentUncached(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null,
  onPartialInfo?: (info: EnvironmentInfo) => void,
  changeRequestStatusEnabled?: boolean,
  diagnostics: EnvironmentLoadDiagnostics = {
    loadId: ++environmentLoadSequence,
    startedAt: environmentNow(),
  }
): Promise<EnvironmentInfo> {
  if (!project && !target) {
    return EMPTY_ENVIRONMENT_INFO
  }

  const executionTarget = project?.config?.execution?.targetType ?? 'local'
  const initialDeviceId = target?.deviceId ?? (project ? executionDeviceId(project) : undefined)
  const baseInfo: EnvironmentInfo = {
    ...EMPTY_ENVIRONMENT_INFO,
    executionTarget,
    deviceId: initialDeviceId,
  }

  if (!initialDeviceId) {
    return baseInfo
  }

  let deviceId: string
  let path: string
  try {
    const context = await traceEnvironmentOperation(diagnostics, 'workspace_context', () =>
      commandContext(api, project, target)
    )
    deviceId = context.deviceId
    path = context.path
    logEnvironmentLoad(diagnostics, 'workspace_ready', { deviceId, path })
  } catch (error) {
    return {
      ...baseInfo,
      error: error instanceof Error ? error.message : 'Failed to load environment info',
    }
  }

  const environmentWorkspaceInfo = {
    ...baseInfo,
    deviceId,
    workspacePath: path,
  }

  try {
    const branchNamePromise = traceEnvironmentOperation(diagnostics, 'git_branch', () =>
      runGitCommand(api, deviceId, 'git_branch', path)
    )
    const shortStatPromise = traceEnvironmentOperation(diagnostics, 'git_diff', () =>
      loadBranchDiffShortStat(api, deviceId, path)
    )
    const porcelainPromise = traceEnvironmentOperation(diagnostics, 'git_status', () =>
      runGitCommand(api, deviceId, 'git_status_porcelain', path)
    ).catch(() => '')
    const remoteUrlPromise = traceEnvironmentOperation(diagnostics, 'git_remote', () =>
      runGitCommand(api, deviceId, 'git_remote_url', path)
    ).catch(() => '')
    const changeRequestEnabledPromise =
      changeRequestStatusEnabled === undefined
        ? traceEnvironmentOperation(diagnostics, 'change_request_preference', () =>
            getAppPreferences().then(preferences => preferences.changeRequestStatusEnabled)
          )
        : Promise.resolve(changeRequestStatusEnabled)
    const branchInfoPromise = Promise.all([branchNamePromise, remoteUrlPromise]).then(
      ([branchName, remoteUrl]) => {
        const branchInfo: EnvironmentInfo = {
          ...environmentWorkspaceInfo,
          additions: '',
          deletions: '',
          isGitRepository: true,
          branchName,
          createPullRequestUrl: buildPullRequestUrl(remoteUrl, branchName),
        }
        logEnvironmentLoad(diagnostics, 'branch_published', { branchName })
        onPartialInfo?.(branchInfo)
        return { branchInfo, branchName, remoteUrl }
      }
    )
    const changeRequestPromise = Promise.all([branchInfoPromise, changeRequestEnabledPromise]).then(
      async ([{ branchInfo, branchName, remoteUrl }, changeRequestStatusEnabled]) => {
        const changeRequest = changeRequestStatusEnabled
          ? await loadChangeRequest(
              api,
              deviceId,
              path,
              remoteUrl,
              branchName,
              diagnostics,
              initialLookup => {
                logEnvironmentLoad(diagnostics, 'change_request_published', {
                  state: initialLookup.state,
                  number: initialLookup.changeRequest?.number,
                })
                onPartialInfo?.({ ...branchInfo, changeRequest: initialLookup })
              }
            )
          : undefined
        if (changeRequest) {
          logEnvironmentLoad(diagnostics, 'change_request_final_published', {
            state: changeRequest.state,
            number: changeRequest.changeRequest?.number,
          })
          onPartialInfo?.({ ...branchInfo, changeRequest })
        }
        return changeRequest
      }
    )
    const [{ branchName, remoteUrl }, shortStat, porcelain, changeRequest] = await Promise.all([
      branchInfoPromise,
      shortStatPromise,
      porcelainPromise,
      changeRequestPromise,
    ])
    const diff = parseGitShortStat(shortStat ?? '')
    const porcelainLines = porcelain.split('\n').filter(line => line.trim().length > 0)

    // git diff --shortstat counts changed lines of tracked files, which is the
    // same basis code hosting uses, so untracked files never inflate the line
    // counts. Only a repository without any commit baseline falls back to the
    // pending file count; a committed repository keeps the (empty) shortstat.
    if (
      shortStat === null &&
      porcelainLines.length > 0 &&
      !porcelainHasTrackedChanges(porcelainLines)
    ) {
      diff.additions = `+${porcelainLines.length}`
    }

    const result = {
      ...environmentWorkspaceInfo,
      ...diff,
      isGitRepository: true,
      branchName,
      createPullRequestUrl: buildPullRequestUrl(remoteUrl, branchName),
      ...(changeRequest ? { changeRequest } : {}),
    }
    logEnvironmentLoad(diagnostics, 'completed', {
      branchName,
      changeRequestState: changeRequest?.state,
      changeRequestNumber: changeRequest?.changeRequest?.number,
    })
    return result
  } catch (error) {
    const isGitRepository = await probeGitRepository(api, deviceId, path).catch(() => undefined)
    if (isGitRepository === false) {
      return {
        ...environmentWorkspaceInfo,
        isGitRepository: false,
      }
    }

    return {
      ...environmentWorkspaceInfo,
      error: error instanceof Error ? error.message : 'Failed to load environment info',
    }
  }
}

export async function loadProjectEnvironment(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null,
  options: EnvironmentInfoLoadOptions = {}
): Promise<EnvironmentInfo> {
  const diagnostics: EnvironmentLoadDiagnostics = {
    loadId: ++environmentLoadSequence,
    startedAt: environmentNow(),
  }
  if (!project && !target) {
    return cloneEnvironmentInfo(EMPTY_ENVIRONMENT_INFO)
  }

  const workspaceCacheKey = environmentInfoCacheKey(project, target)
  if (!workspaceCacheKey) {
    logEnvironmentLoad(diagnostics, 'cache_bypassed')
    return loadProjectEnvironmentUncached(
      api,
      project,
      target,
      options.onPartialInfo,
      options.changeRequestStatusEnabled,
      diagnostics
    )
  }
  const cacheKey = `${workspaceCacheKey}\0change-request:${String(
    options.changeRequestStatusEnabled ?? 'preference'
  )}`

  const now = Date.now()
  const environmentInfoCache = getEnvironmentInfoCache(api)
  const cached = environmentInfoCache.get(cacheKey)
  // Forced polling must still share an in-flight load. Replacing a slow request
  // on every poll prevents any result from settling the environment loading state.
  if (cached && (!cached.settled || (!options.force && cached.expiresAt > now))) {
    logEnvironmentLoad(diagnostics, cached.settled ? 'cache_hit' : 'cache_joined', {
      force: Boolean(options.force),
      expiresInMs: cached.expiresAt - now,
    })
    if (options.onPartialInfo) {
      cached.partialState.listeners.add(options.onPartialInfo)
      if (cached.partialState.info) {
        options.onPartialInfo(cloneEnvironmentInfo(cached.partialState.info))
      }
    }
    try {
      const info = cloneEnvironmentInfo(await cached.promise)
      logEnvironmentLoad(diagnostics, 'cache_result_returned')
      return info
    } finally {
      if (options.onPartialInfo) {
        cached.partialState.listeners.delete(options.onPartialInfo)
      }
    }
  }
  const staleInfo =
    !options.force && cached?.settled && cached.value
      ? cloneEnvironmentInfo(cached.value)
      : undefined
  if (staleInfo && options.onPartialInfo) {
    logEnvironmentLoad(diagnostics, 'stale_cache_published', {
      branchName: staleInfo.branchName,
      changeRequestNumber: staleInfo.changeRequest?.changeRequest?.number,
    })
    options.onPartialInfo(cloneEnvironmentInfo(staleInfo))
  }

  const partialState: EnvironmentInfoCacheEntry['partialState'] = {
    info: staleInfo,
    listeners: new Set(options.onPartialInfo ? [options.onPartialInfo] : []),
  }
  const promise = loadProjectEnvironmentUncached(
    api,
    project,
    target,
    partialInfo => {
      const previousInfo = partialState.info
      partialState.info =
        previousInfo &&
        previousInfo.workspacePath === partialInfo.workspacePath &&
        previousInfo.deviceId === partialInfo.deviceId &&
        !partialInfo.changeRequest
          ? {
              ...partialInfo,
              ...(previousInfo.changeRequest ? { changeRequest: previousInfo.changeRequest } : {}),
            }
          : cloneEnvironmentInfo(partialInfo)
      partialState.listeners.forEach(listener =>
        listener(cloneEnvironmentInfo(partialState.info ?? partialInfo))
      )
    },
    options.changeRequestStatusEnabled,
    diagnostics
  )
  logEnvironmentLoad(diagnostics, 'cache_miss', {
    force: Boolean(options.force),
    revalidatingStale: Boolean(staleInfo),
  })
  const entry: EnvironmentInfoCacheEntry = {
    expiresAt: now + ENVIRONMENT_INFO_CACHE_TTL_MS,
    promise,
    settled: false,
    partialState,
  }
  environmentInfoCache.set(cacheKey, entry)
  void promise.then(
    info => {
      entry.value = cloneEnvironmentInfo(info)
      entry.settled = true
    },
    () => {
      entry.settled = true
    }
  )

  try {
    return cloneEnvironmentInfo(await promise)
  } catch (error) {
    environmentInfoCache.delete(cacheKey)
    throw error
  } finally {
    if (options.onPartialInfo) {
      entry.partialState.listeners.delete(options.onPartialInfo)
    }
  }
}

export async function loadProjectEnvironmentDiff(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null,
  mode: EnvironmentDiffMode = 'branch'
): Promise<string> {
  const { deviceId, path } = await commandContext(api, project, target)
  return runGitCommand(api, deviceId, ENVIRONMENT_DIFF_COMMANDS[mode], path, {
    timeoutSeconds: 30,
    maxOutputBytes: 5 * 1024 * 1024,
  })
}

export async function commitProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  message: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  let commitMessage = message.trim()

  const { deviceId, path } = await commandContext(api, project, target)

  await runGitCommand(api, deviceId, 'git_add_all', path, {
    timeoutSeconds: 30,
    maxOutputBytes: 4096,
  })

  if (!commitMessage) {
    const stagedDiff = await runGitCommand(api, deviceId, 'git_diff_staged', path, {
      timeoutSeconds: 30,
      maxOutputBytes: 4096,
    })
    if (!stagedDiff.trim()) {
      throw new Error(NO_CHANGES_TO_COMMIT_MESSAGE)
    }
    commitMessage = await generateCommitMessage(api, deviceId, path)
  }

  await runGitCommand(api, deviceId, 'git_commit', path, {
    args: ['-m', commitMessage],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}

export async function pushProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  const { deviceId, path } = await commandContext(api, project, target)
  await runGitCommand(api, deviceId, 'git_push', path, {
    timeoutSeconds: 120,
    maxOutputBytes: 8192,
  })
}

export async function commitAndPushProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  message: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  await commitProjectChanges(api, project, message, target)
  await pushProjectChanges(api, project, target)
}

export async function listProjectBranches(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  target?: EnvironmentWorkspaceTarget | null
): Promise<string[]> {
  const { deviceId, path } = await commandContext(api, project, target)
  const [output, currentBranch] = await Promise.all([
    runGitCommand(api, deviceId, 'git_branch_list', path, {
      timeoutSeconds: 15,
      maxOutputBytes: 1024 * 64,
    }),
    runGitCommand(api, deviceId, 'git_branch', path).catch(() => ''),
  ])

  const branches = output
    .split('\n')
    .map(branch => branch.trim())
    .filter(Boolean)
  return prioritizeBranches(branches, [currentBranch])
}

export async function checkoutProjectBranch(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  branchName: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  const { deviceId, path } = await commandContext(api, project, target)
  await runGitCommand(api, deviceId, 'git_checkout', path, {
    args: [trimmedBranch],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}

export async function createAndCheckoutProjectBranch(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  branchName: string,
  target?: EnvironmentWorkspaceTarget | null
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  const { deviceId, path } = await commandContext(api, project, target)
  await runGitCommand(api, deviceId, 'git_checkout_new', path, {
    args: [trimmedBranch],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}
