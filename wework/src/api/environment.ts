import type { DeviceCommandRequest, DeviceCommandResponse, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkspaceTarget } from '@/types/workspace-files'
import {
  configuredWorkspacePath,
  executionDeviceId,
  resolveProjectWorkspacePath,
} from '@/lib/project-workspace'

interface DeviceCommandApi {
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

export type EnvironmentDiffMode = 'branch' | 'unstaged' | 'staged' | 'commit'

export interface EnvironmentInfoLoadOptions {
  force?: boolean
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
}

const environmentInfoCaches = new WeakMap<
  DeviceCommandApi,
  Map<string, EnvironmentInfoCacheEntry>
>()

function outputAsString(output: DeviceCommandResponse['stdout']): string {
  if (typeof output === 'string') {
    return output
  }
  if (Array.isArray(output) && output.every(item => typeof item === 'string')) {
    return output.join('\n')
  }
  throw new Error('Expected text stdout from device command')
}

function outputAsRecord(output: DeviceCommandResponse['stdout']): Record<string, unknown> | null {
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

function isNotGitRepositoryError(error: unknown): boolean {
  return error instanceof Error && /not a git repository/i.test(error.message)
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

function parseGitRemote(remoteUrl: string): GitRemoteParts | null {
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
    return {
      host: url.host,
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
): Promise<string> {
  // Compare the current branch with its merge base to the primary branch.
  // This includes committed branch changes as well as tracked worktree changes.
  try {
    return await runGitCommand(api, deviceId, 'git_branch_diff_shortstat', path)
  } catch {
    // HEAD may not exist (no commits yet).
    return ''
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
  target?: EnvironmentWorkspaceTarget | null
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
    const context = await commandContext(api, project, target)
    deviceId = context.deviceId
    path = context.path
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
    const [branchName, shortStat, porcelain] = await Promise.all([
      runGitCommand(api, deviceId, 'git_branch', path),
      loadBranchDiffShortStat(api, deviceId, path),
      runGitCommand(api, deviceId, 'git_status_porcelain', path).catch(() => ''),
    ])
    const remoteUrl = await runGitCommand(api, deviceId, 'git_remote_url', path).catch(() => '')
    const diff = parseGitShortStat(shortStat)

    // Count pending files from porcelain (untracked, staged, modified).
    // git diff --shortstat only covers tracked files, so we merge
    // porcelain data to include untracked and no-commit scenarios.
    const porcelainLines = porcelain.split('\n').filter(line => line.trim().length > 0)

    if (shortStat) {
      // Repo has commits — diff stat covers tracked changes.
      // Add untracked file count on top.
      const untrackedCount = porcelainLines.filter(line => line.startsWith('??')).length
      if (untrackedCount > 0) {
        const trackedAdditions = parseInt(diff.additions.replace(/^\+/, ''), 10) || 0
        diff.additions = `+${trackedAdditions + untrackedCount}`
      }
    } else if (porcelainLines.length > 0) {
      // Repo has no commits — every porcelain line is a pending change.
      diff.additions = `+${porcelainLines.length}`
    }

    return {
      ...environmentWorkspaceInfo,
      ...diff,
      isGitRepository: true,
      branchName,
      createPullRequestUrl: buildPullRequestUrl(remoteUrl, branchName),
    }
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
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
  if (!project && !target) {
    return cloneEnvironmentInfo(EMPTY_ENVIRONMENT_INFO)
  }

  const cacheKey = environmentInfoCacheKey(project, target)
  if (!cacheKey) {
    return loadProjectEnvironmentUncached(api, project, target)
  }

  const now = Date.now()
  const environmentInfoCache = getEnvironmentInfoCache(api)
  const cached = environmentInfoCache.get(cacheKey)
  if (!options.force && cached && cached.expiresAt > now) {
    return cloneEnvironmentInfo(await cached.promise)
  }

  const promise = loadProjectEnvironmentUncached(api, project, target)
  environmentInfoCache.set(cacheKey, {
    expiresAt: now + ENVIRONMENT_INFO_CACHE_TTL_MS,
    promise,
  })

  try {
    return cloneEnvironmentInfo(await promise)
  } catch (error) {
    environmentInfoCache.delete(cacheKey)
    throw error
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
