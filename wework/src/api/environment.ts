import type { DeviceCommandRequest, DeviceCommandResponse, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import {
  configuredWorkspacePath,
  executionDeviceId,
  resolveProjectWorkspacePath,
} from '@/lib/project-workspace'

interface DeviceCommandApi {
  executeCommand(deviceId: string, data: DeviceCommandRequest): Promise<DeviceCommandResponse>
}

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

function environmentInfoCacheKey(project: ProjectWithTasks): string | null {
  const deviceId = executionDeviceId(project)
  if (!deviceId) {
    return null
  }

  const config = project.config
  const workspace = config?.workspace
  return JSON.stringify({
    projectId: project.id,
    deviceId,
    executionTarget: config?.execution?.targetType ?? 'local',
    workspaceSource: workspace?.source,
    workspacePath: configuredWorkspacePath(project),
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
    throw new Error(response.error || response.stderr || `${commandKey} failed`)
  }

  return outputAsString(response.stdout).trim()
}

async function loadBranchDiffShortStat(
  api: DeviceCommandApi,
  deviceId: string,
  path: string
): Promise<string> {
  // Use diff against HEAD for tracked uncommitted line changes.
  // This captures staged + unstaged modifications to tracked files.
  try {
    return await runGitCommand(api, deviceId, 'git_diff_shortstat', path, {
      args: ['HEAD', '--'],
    })
  } catch {
    // HEAD may not exist (no commits yet).
    return ''
  }
}

async function commandContext(
  api: DeviceCommandApi,
  project: ProjectWithTasks
): Promise<{ deviceId: string; path: string }> {
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
  project: ProjectWithTasks | null
): Promise<EnvironmentInfo> {
  if (!project) {
    return EMPTY_ENVIRONMENT_INFO
  }

  const executionTarget = project.config?.execution?.targetType ?? 'local'
  const deviceId = executionDeviceId(project)
  const baseInfo: EnvironmentInfo = {
    ...EMPTY_ENVIRONMENT_INFO,
    executionTarget,
    deviceId,
  }

  if (!deviceId) {
    return baseInfo
  }

  try {
    const path = await workspacePath(api, deviceId, project)
    if (!path) {
      return baseInfo
    }
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
      ...baseInfo,
      ...diff,
      branchName,
      createPullRequestUrl: buildPullRequestUrl(remoteUrl, branchName),
    }
  } catch (error) {
    return {
      ...baseInfo,
      error: error instanceof Error ? error.message : 'Failed to load environment info',
    }
  }
}

export async function loadProjectEnvironment(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null
): Promise<EnvironmentInfo> {
  if (!project) {
    return cloneEnvironmentInfo(EMPTY_ENVIRONMENT_INFO)
  }

  const cacheKey = environmentInfoCacheKey(project)
  if (!cacheKey) {
    return loadProjectEnvironmentUncached(api, project)
  }

  const now = Date.now()
  const environmentInfoCache = getEnvironmentInfoCache(api)
  const cached = environmentInfoCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cloneEnvironmentInfo(await cached.promise)
  }

  const promise = loadProjectEnvironmentUncached(api, project)
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
  project: ProjectWithTasks | null
): Promise<string> {
  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = await commandContext(api, project)
  return runGitCommand(api, deviceId, 'git_diff', path, {
    timeoutSeconds: 30,
    maxOutputBytes: 5 * 1024 * 1024,
  })
}

export async function commitProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  message: string
): Promise<void> {
  const trimmedMessage = message.trim()

  if (!trimmedMessage) {
    throw new Error('Commit message is required')
  }

  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = await commandContext(api, project)

  await runGitCommand(api, deviceId, 'git_add_all', path, {
    timeoutSeconds: 30,
    maxOutputBytes: 4096,
  })
  await runGitCommand(api, deviceId, 'git_commit', path, {
    args: ['-m', trimmedMessage],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}

export async function listProjectBranches(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null
): Promise<string[]> {
  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = await commandContext(api, project)
  const output = await runGitCommand(api, deviceId, 'git_branch_list', path, {
    timeoutSeconds: 15,
    maxOutputBytes: 1024 * 64,
  })

  return output
    .split('\n')
    .map(branch => branch.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
}

export async function checkoutProjectBranch(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  branchName: string
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = await commandContext(api, project)
  await runGitCommand(api, deviceId, 'git_checkout', path, {
    args: [trimmedBranch],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}

export async function createAndCheckoutProjectBranch(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  branchName: string
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = await commandContext(api, project)
  await runGitCommand(api, deviceId, 'git_checkout_new', path, {
    args: [trimmedBranch],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}
