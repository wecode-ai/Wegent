import type { DeviceCommandRequest, DeviceCommandResponse, ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'

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
const DEFAULT_DIFF_BASE_REFS = ['main', 'origin/main', 'master', 'origin/master']
const INVALID_BRANCH_CHARACTERS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\', ']'])

function outputAsString(output: DeviceCommandResponse['stdout']): string {
  return Array.isArray(output) ? output.join('\n') : output
}

function workspacePath(project: ProjectWithTasks): string | undefined {
  const config = project.config
  if (config?.workspace?.source === 'git' && config.workspace.checkoutPath) {
    return `projects/${config.workspace.checkoutPath}`
  }
  return config?.workspace?.localPath || config?.workspace?.checkoutPath || config?.path
}

function executionDeviceId(project: ProjectWithTasks): string | undefined {
  const config = project.config
  return config?.execution?.deviceId || config?.device_id
}

function validateBranchName(branchName: string): void {
  const components = branchName.split('/')
  const invalidComponent = components.some(
    component => !component || component.startsWith('.') || component.endsWith('.lock'),
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
  } = {},
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
  path: string,
): Promise<string> {
  for (const baseRef of DEFAULT_DIFF_BASE_REFS) {
    try {
      return await runGitCommand(api, deviceId, 'git_diff_shortstat', path, {
        args: [`${baseRef}...`, '--'],
      })
    } catch {
      // Try the next common base ref when this repository does not have one.
    }
  }

  try {
    return await runGitCommand(api, deviceId, 'git_diff_shortstat', path, {
      args: ['HEAD', '--'],
    })
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Failed to load branch diff stat')
  }
}

function commandContext(project: ProjectWithTasks): { deviceId: string; path: string } {
  const deviceId = executionDeviceId(project)
  const path = workspacePath(project)

  if (!deviceId || !path) {
    throw new Error('Project device and workspace path are required')
  }

  return { deviceId, path }
}

export async function loadProjectEnvironment(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
): Promise<EnvironmentInfo> {
  if (!project) {
    return EMPTY_ENVIRONMENT_INFO
  }

  const executionTarget = project.config?.execution?.targetType ?? 'local'
  const deviceId = executionDeviceId(project)
  const path = workspacePath(project)
  const baseInfo: EnvironmentInfo = {
    ...EMPTY_ENVIRONMENT_INFO,
    executionTarget,
    deviceId,
  }

  if (!deviceId || !path) {
    return baseInfo
  }

  try {
    const [branchName, shortStat] = await Promise.all([
      runGitCommand(api, deviceId, 'git_branch', path),
      loadBranchDiffShortStat(api, deviceId, path),
    ])
    const remoteUrl = await runGitCommand(api, deviceId, 'git_remote_url', path).catch(
      () => '',
    )
    const diff = parseGitShortStat(shortStat)

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

export async function commitProjectChanges(
  api: DeviceCommandApi,
  project: ProjectWithTasks | null,
  message: string,
): Promise<void> {
  const trimmedMessage = message.trim()

  if (!trimmedMessage) {
    throw new Error('Commit message is required')
  }

  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = commandContext(project)

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
  project: ProjectWithTasks | null,
): Promise<string[]> {
  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = commandContext(project)
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
  branchName: string,
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = commandContext(project)
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
): Promise<void> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    throw new Error('Branch name is required')
  }
  validateBranchName(trimmedBranch)
  if (!project) {
    throw new Error('Project is required')
  }

  const { deviceId, path } = commandContext(project)
  await runGitCommand(api, deviceId, 'git_checkout_new', path, {
    args: [trimmedBranch],
    timeoutSeconds: 30,
    maxOutputBytes: 8192,
  })
}
