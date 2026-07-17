import { isUsableDevice } from '@/lib/device-capabilities'
import type {
  DeviceInfo,
  RuntimeDeviceWorkspace,
  RuntimeProjectRef,
  RuntimeProjectRoot,
  RuntimeProjectWork,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import { EMPTY_RUNTIME_WORK, mergeRuntimeWorkLists } from './workbenchCloudStatus'

const REMOTE_RUNTIME_WORK_CACHE_VERSION = 1
const REMOTE_RUNTIME_WORK_CACHE_KEY_PREFIX = 'wework.workbench.remoteRuntimeWork.v1'

interface RemoteRuntimeWorkCacheEnvelope {
  version: typeof REMOTE_RUNTIME_WORK_CACHE_VERSION
  updatedAt: number
  runtimeWork: RuntimeWorkListResponse
}

function cacheKey(userId: number): string {
  return `${REMOTE_RUNTIME_WORK_CACHE_KEY_PREFIX}.${userId}`
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function nullableStringValue(value: unknown): string | null | undefined {
  return value === null ? null : stringValue(value)
}

function finiteNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nullableNumberValue(value: unknown): number | null | undefined {
  return value === null ? null : finiteNumberValue(value)
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function sanitizeProjectRoot(value: unknown): RuntimeProjectRoot | null {
  const root = recordValue(value)
  const kind = stringValue(root.kind)
  const path = stringValue(root.path)
  if (!kind || !path) return null
  return {
    kind,
    path,
    ...(nullableStringValue(root.label) !== undefined
      ? { label: nullableStringValue(root.label) }
      : {}),
  }
}

function sanitizeProjectRef(value: unknown): RuntimeProjectRef | null {
  const project = recordValue(value)
  const key = stringValue(project.key)
  const name = stringValue(project.name)
  if (!key || !name) return null

  const roots = Array.isArray(project.roots)
    ? project.roots
        .map(sanitizeProjectRoot)
        .filter((root): root is RuntimeProjectRoot => root !== null)
    : undefined

  return {
    key,
    name,
    ...(nullableStringValue(project.sidebarStateKey) !== undefined
      ? { sidebarStateKey: nullableStringValue(project.sidebarStateKey) }
      : {}),
    ...(finiteNumberValue(project.id) !== undefined ? { id: finiteNumberValue(project.id) } : {}),
    ...(nullableStringValue(project.description) !== undefined
      ? { description: nullableStringValue(project.description) }
      : {}),
    ...(nullableStringValue(project.color) !== undefined
      ? { color: nullableStringValue(project.color) }
      : {}),
    ...(stringValue(project.kind) ? { kind: stringValue(project.kind) } : {}),
    ...(stringValue(project.source) ? { source: stringValue(project.source) } : {}),
    ...(nullableStringValue(project.stateDeviceId) !== undefined
      ? { stateDeviceId: nullableStringValue(project.stateDeviceId) }
      : {}),
    ...(roots ? { roots } : {}),
    ...(booleanValue(project.pinned) !== undefined ? { pinned: booleanValue(project.pinned) } : {}),
    ...(nullableNumberValue(project.pinnedOrder) !== undefined
      ? { pinnedOrder: nullableNumberValue(project.pinnedOrder) }
      : {}),
    ...(booleanValue(project.active) !== undefined ? { active: booleanValue(project.active) } : {}),
  }
}

const CACHED_GIT_INFO_KEYS = [
  'branch',
  'branchName',
  'branch_name',
  'currentBranch',
  'current_branch',
  'originUrl',
  'origin_url',
  'repoUrl',
  'repo_url',
  'branchMismatch',
  'branch_mismatch',
  'isBranchOutdated',
  'is_branch_outdated',
] as const

function sanitizeGitInfo(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null
  const input = recordValue(value)
  const gitInfo = Object.fromEntries(
    CACHED_GIT_INFO_KEYS.flatMap(key => {
      const field = input[key]
      return typeof field === 'string' || typeof field === 'boolean' ? [[key, field]] : []
    })
  )
  return Object.keys(gitInfo).length > 0 ? gitInfo : undefined
}

function sanitizeTask(value: unknown, workspacePath: string): RuntimeTaskSummary | null {
  const task = recordValue(value)
  const taskId = stringValue(task.taskId)
  const title = stringValue(task.title)
  const runtime = stringValue(task.runtime)
  if (!taskId || !title || !runtime) return null

  const gitInfo = sanitizeGitInfo(task.gitInfo)
  return {
    taskId,
    title,
    runtime,
    workspacePath: stringValue(task.workspacePath) ?? workspacePath,
    running: false,
    ...(nullableStringValue(task.threadId) !== undefined
      ? { threadId: nullableStringValue(task.threadId) }
      : {}),
    ...(nullableStringValue(task.workspaceKind) !== undefined
      ? { workspaceKind: nullableStringValue(task.workspaceKind) }
      : {}),
    ...(nullableStringValue(task.worktreeId) !== undefined
      ? { worktreeId: nullableStringValue(task.worktreeId) }
      : {}),
    ...(gitInfo !== undefined ? { gitInfo } : {}),
    ...(typeof task.createdAt === 'string' || typeof task.createdAt === 'number'
      ? { createdAt: task.createdAt }
      : {}),
    ...(typeof task.updatedAt === 'string' || typeof task.updatedAt === 'number'
      ? { updatedAt: task.updatedAt }
      : {}),
    ...(booleanValue(task.pinned) !== undefined ? { pinned: booleanValue(task.pinned) } : {}),
    ...(nullableNumberValue(task.pinnedOrder) !== undefined
      ? { pinnedOrder: nullableNumberValue(task.pinnedOrder) }
      : {}),
    ...(nullableNumberValue(task.sidebarOrder) !== undefined
      ? { sidebarOrder: nullableNumberValue(task.sidebarOrder) }
      : {}),
    ...(nullableStringValue(task.status) !== undefined
      ? { status: nullableStringValue(task.status) }
      : {}),
  }
}

function sanitizeWorkspace(value: unknown): RuntimeDeviceWorkspace | null {
  const workspace = recordValue(value)
  const deviceId = stringValue(workspace.deviceId)
  const workspacePath = stringValue(workspace.workspacePath)
  if (!deviceId || !workspacePath) return null

  const tasks = Array.isArray(workspace.tasks)
    ? workspace.tasks
        .map(task => sanitizeTask(task, workspacePath))
        .filter((task): task is RuntimeTaskSummary => task !== null)
    : []

  return {
    deviceId,
    workspacePath,
    available: false,
    deviceStatus: 'offline',
    workspaceSource: 'remote',
    remoteHostId: stringValue(workspace.remoteHostId) ?? deviceId,
    tasks,
    ...(nullableNumberValue(workspace.id) !== undefined
      ? { id: nullableNumberValue(workspace.id) }
      : {}),
    ...(nullableNumberValue(workspace.projectId) !== undefined
      ? { projectId: nullableNumberValue(workspace.projectId) }
      : {}),
    ...(nullableStringValue(workspace.deviceName) !== undefined
      ? { deviceName: nullableStringValue(workspace.deviceName) }
      : {}),
    ...(nullableStringValue(workspace.workspaceKind) !== undefined
      ? { workspaceKind: nullableStringValue(workspace.workspaceKind) }
      : {}),
    ...(nullableStringValue(workspace.worktreeId) !== undefined
      ? { worktreeId: nullableStringValue(workspace.worktreeId) }
      : {}),
    ...(nullableStringValue(workspace.label) !== undefined
      ? { label: nullableStringValue(workspace.label) }
      : {}),
    ...(nullableStringValue(workspace.repoUrl) !== undefined
      ? { repoUrl: nullableStringValue(workspace.repoUrl) }
      : {}),
    ...(nullableStringValue(workspace.repoRootFingerprint) !== undefined
      ? { repoRootFingerprint: nullableStringValue(workspace.repoRootFingerprint) }
      : {}),
    ...(booleanValue(workspace.mapped) !== undefined
      ? { mapped: booleanValue(workspace.mapped) }
      : {}),
  }
}

function sanitizeProjectWork(value: unknown): RuntimeProjectWork | null {
  const projectWork = recordValue(value)
  const project = sanitizeProjectRef(projectWork.project)
  if (!project) return null
  const deviceWorkspaces = Array.isArray(projectWork.deviceWorkspaces)
    ? projectWork.deviceWorkspaces
        .map(sanitizeWorkspace)
        .filter((workspace): workspace is RuntimeDeviceWorkspace => workspace !== null)
    : []
  return {
    project,
    deviceWorkspaces,
    totalTasks: deviceWorkspaces.reduce((total, workspace) => total + workspace.tasks.length, 0),
  }
}

export function createRemoteRuntimeWorkCacheSnapshot(value: unknown): RuntimeWorkListResponse {
  const runtimeWork = recordValue(value)
  const projects = Array.isArray(runtimeWork.projects)
    ? runtimeWork.projects
        .map(sanitizeProjectWork)
        .filter((project): project is RuntimeProjectWork => project !== null)
    : []
  const chats = Array.isArray(runtimeWork.chats)
    ? runtimeWork.chats
        .map(sanitizeWorkspace)
        .filter((workspace): workspace is RuntimeDeviceWorkspace => workspace !== null)
    : []
  return {
    projects,
    chats,
    totalTasks:
      projects.reduce((total, project) => total + (project.totalTasks ?? 0), 0) +
      chats.reduce((total, workspace) => total + workspace.tasks.length, 0),
  }
}

export function readCachedRemoteRuntimeWork(userId: number): RuntimeWorkListResponse {
  try {
    const raw = window.localStorage.getItem(cacheKey(userId))
    if (!raw) return EMPTY_RUNTIME_WORK
    const envelope = recordValue(JSON.parse(raw))
    if (envelope.version !== REMOTE_RUNTIME_WORK_CACHE_VERSION) return EMPTY_RUNTIME_WORK
    return createRemoteRuntimeWorkCacheSnapshot(envelope.runtimeWork)
  } catch {
    return EMPTY_RUNTIME_WORK
  }
}

export function writeCachedRemoteRuntimeWork(
  userId: number,
  runtimeWork: RuntimeWorkListResponse,
  devices?: DeviceInfo[]
): RuntimeWorkListResponse {
  const snapshot = withCachedDeviceLabels(
    createRemoteRuntimeWorkCacheSnapshot(runtimeWork),
    devices
  )
  const envelope: RemoteRuntimeWorkCacheEnvelope = {
    version: REMOTE_RUNTIME_WORK_CACHE_VERSION,
    updatedAt: Date.now(),
    runtimeWork: snapshot,
  }
  try {
    window.localStorage.setItem(cacheKey(userId), JSON.stringify(envelope))
  } catch {
    // The current runtime work remains available when persistent storage is unavailable.
  }
  return snapshot
}

function runtimeWorkspaces(runtimeWork: RuntimeWorkListResponse): RuntimeDeviceWorkspace[] {
  return [
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
    ...runtimeWork.chats,
  ]
}

function deviceAliases(device: DeviceInfo): Set<string> {
  return new Set(
    [
      device.device_id,
      device.app_device_id,
      device.socket_device_id,
      device.runtime_instance_id,
      ...(device.runtime_routes ?? []).flatMap(route => [route.device_id, route.runtime_device_id]),
    ]
      .map(value => value?.trim())
      .filter((value): value is string => Boolean(value))
  )
}

function workspaceAliases(workspace: RuntimeDeviceWorkspace): Set<string> {
  return new Set(
    [workspace.deviceId, workspace.remoteHostId]
      .map(value => value?.trim())
      .filter((value): value is string => Boolean(value))
  )
}

function aliasesIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

function networkHost(value?: string | null): string | null {
  const label = value?.trim()
  if (!label) return null
  const bracketMatch = label.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]
  const colonParts = label.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }
  return label
}

function withCachedDeviceLabels(
  runtimeWork: RuntimeWorkListResponse,
  devices?: DeviceInfo[]
): RuntimeWorkListResponse {
  if (!devices) return runtimeWork
  const deviceRecords = devices.map(device => ({
    device,
    aliases: deviceAliases(device),
  }))
  const annotateWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => {
    const aliases = workspaceAliases(workspace)
    const device = deviceRecords.find(record => aliasesIntersect(aliases, record.aliases))?.device
    const deviceName =
      networkHost(device?.client_ip) ??
      networkHost(device?.runtime_transfer_host) ??
      workspace.deviceName
    return deviceName ? { ...workspace, deviceName } : workspace
  }
  return {
    ...runtimeWork,
    projects: runtimeWork.projects.map(project => ({
      ...project,
      deviceWorkspaces: project.deviceWorkspaces.map(annotateWorkspace),
    })),
    chats: runtimeWork.chats.map(annotateWorkspace),
  }
}

function filterRuntimeWorkspaces(
  runtimeWork: RuntimeWorkListResponse,
  keep: (workspace: RuntimeDeviceWorkspace) => boolean
): RuntimeWorkListResponse {
  const projects = runtimeWork.projects
    .map(project => {
      const deviceWorkspaces = project.deviceWorkspaces.filter(keep)
      return {
        ...project,
        deviceWorkspaces,
        totalTasks: deviceWorkspaces.reduce(
          (total, workspace) => total + workspace.tasks.length,
          0
        ),
      }
    })
    .filter(project => project.deviceWorkspaces.length > 0)
  const chats = runtimeWork.chats.filter(keep)
  return {
    projects,
    chats,
    totalTasks:
      projects.reduce((total, project) => total + (project.totalTasks ?? 0), 0) +
      chats.reduce((total, workspace) => total + workspace.tasks.length, 0),
  }
}

export function reconcileCachedRemoteRuntimeWork(
  cachedRuntimeWork: RuntimeWorkListResponse,
  liveRuntimeWork: RuntimeWorkListResponse,
  devices?: DeviceInfo[]
): RuntimeWorkListResponse {
  const cachedSnapshot = createRemoteRuntimeWorkCacheSnapshot(cachedRuntimeWork)
  const liveWorkspaceAliases = runtimeWorkspaces(liveRuntimeWork).map(workspaceAliases)
  const deviceRecords = devices?.map(device => ({
    aliases: deviceAliases(device),
    available: isUsableDevice(device),
  }))

  const preservedCache = filterRuntimeWorkspaces(cachedSnapshot, workspace => {
    const aliases = workspaceAliases(workspace)
    if (deviceRecords) {
      const device = deviceRecords.find(record => aliasesIntersect(aliases, record.aliases))
      return Boolean(device && !device.available)
    }
    return !liveWorkspaceAliases.some(liveAliases => aliasesIntersect(aliases, liveAliases))
  })

  return mergeRuntimeWorkLists(preservedCache, liveRuntimeWork, { devices })
}
