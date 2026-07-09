import { joinDevicePath } from '@/lib/device-workspace-path'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import type {
  DeviceInfo,
  RuntimeTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import type { RuntimeTaskRoute } from '@/lib/navigation'

export const STANDALONE_PROJECT_ID = 0
export const EMPTY_MESSAGE_TASK_TITLE = '新对话'

const DEFAULT_CONVERSATION_WORKSPACE_NAME = 'new-chat'
const MAX_CONVERSATION_WORKSPACE_NAME_LENGTH = 20

export async function createConversationWorkspace(
  deviceApi: {
    createDirectory: (deviceId: string, path: string) => Promise<void>
    getHomeDirectory: (deviceId: string) => Promise<string>
  },
  deviceId: string,
  message: string,
  taskId: string
): Promise<string> {
  const homeDirectory = await deviceApi.getHomeDirectory(deviceId)
  const workspacePath = buildConversationWorkspacePath(homeDirectory, message, taskId)
  await deviceApi.createDirectory(deviceId, workspacePath)
  return workspacePath
}

function buildConversationWorkspacePath(
  homeDirectory: string,
  message: string,
  taskId: string
): string {
  return joinDevicePath(
    homeDirectory,
    'Documents',
    'Codex',
    formatConversationWorkspaceDate(new Date()),
    conversationWorkspaceName(message, taskId)
  )
}

function formatConversationWorkspaceDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function slugifyConversationWorkspaceName(message: string): string {
  const words = message.match(/[A-Za-z0-9]+/g) ?? []
  const name = words.length > 0 ? words.map(word => word.toLowerCase()).join('-') : ''
  return trimConversationWorkspaceName(name || DEFAULT_CONVERSATION_WORKSPACE_NAME)
}

function conversationWorkspaceName(message: string, taskId: string): string {
  const suffix = taskId
    .replace(/[^A-Za-z0-9]+/g, '')
    .slice(-8)
    .toLowerCase()
  const name = slugifyConversationWorkspaceName(message)
  return suffix ? `${name}-${suffix}` : name
}

function trimConversationWorkspaceName(name: string): string {
  const trimmed = name.slice(0, MAX_CONVERSATION_WORKSPACE_NAME_LENGTH).replace(/-+$/g, '')
  return trimmed || DEFAULT_CONVERSATION_WORKSPACE_NAME
}

export function getRuntimeTaskRouteKey(route: RuntimeTaskRoute): string {
  return `${route.deviceId}:${route.taskId}:${route.workspacePath ?? ''}`
}

function matchesRequestedWorkspacePath(
  currentPath?: string | null,
  requestedPath?: string | null
): boolean {
  const normalizedRequestedPath = requestedPath?.trim()
  if (!normalizedRequestedPath) return true
  return currentPath?.trim() === normalizedRequestedPath
}

export function isSameRuntimeTaskIdentity(
  address: RuntimeTaskAddress | null,
  route: RuntimeTaskRoute
): boolean {
  return Boolean(
    address &&
    address.deviceId === route.deviceId &&
    address.taskId === route.taskId &&
    matchesRequestedWorkspacePath(address.workspacePath, route.workspacePath)
  )
}

export function isSameRuntimeTaskAddress(
  left: RuntimeTaskAddress | null | undefined,
  right: RuntimeTaskAddress
): boolean {
  return Boolean(
    left &&
    left.deviceId === right.deviceId &&
    left.taskId === right.taskId &&
    matchesRequestedWorkspacePath(left.workspacePath, right.workspacePath)
  )
}

function workspaceTaskAddresses(workspaces: RuntimeDeviceWorkspace[]): RuntimeTaskAddress[] {
  return workspaces.flatMap(workspace =>
    workspace.tasks.map(task => runtimeTaskAddressFromWorkspace(workspace, task))
  )
}

export function getRuntimeTaskWorkspacePath(
  workspace: RuntimeDeviceWorkspace,
  task: { workspacePath?: string | null }
): string {
  if (workspace.workspaceKind === 'worktree' || workspace.worktreeId) {
    return workspace.workspacePath
  }
  return task.workspacePath || workspace.workspacePath
}

function runtimeTaskAddressFromWorkspace(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): RuntimeTaskAddress {
  return {
    deviceId: workspace.deviceId,
    taskId: task.taskId,
    workspacePath: getRuntimeTaskWorkspacePath(workspace, task),
    ...(task.taskId ? { taskId: task.taskId } : {}),
    ...(task.runtimeHandle ? { runtimeHandle: task.runtimeHandle } : {}),
  }
}

export function projectTaskAddresses(
  runtimeWork: RuntimeWorkListResponse | null,
  runtimeProjectKeys: string[]
): RuntimeTaskAddress[] {
  if (!runtimeWork || runtimeProjectKeys.length === 0) return []

  const keySet = new Set(runtimeProjectKeys)
  return runtimeWork.projects.flatMap(projectWork =>
    keySet.has(projectWork.project.key) ? workspaceTaskAddresses(projectWork.deviceWorkspaces) : []
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isDeviceStatus(value: unknown): value is DeviceInfo['status'] {
  return value === 'online' || value === 'offline' || value === 'busy'
}

export function getDeviceEventId(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.device_id !== 'string') return null
  const deviceId = payload.device_id.trim()
  return deviceId || null
}

export function getDeviceEventName(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.name !== 'string') return null
  const name = payload.name.trim()
  return name || null
}

export function getCommandStdoutObject(stdout: unknown): Record<string, unknown> | null {
  return isRecord(stdout) ? stdout : null
}

function getLastProjectStorageKey(userId: number) {
  return `wework.lastProjectId.${userId}`
}

export function writeLastProjectId(userId: number, projectId: number) {
  try {
    window.localStorage.setItem(getLastProjectStorageKey(userId), String(projectId))
  } catch {
    // Ignore storage failures; project selection still works for the current session.
  }
}

export function findRuntimeTask(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null | undefined
): RuntimeTaskSummary | null {
  if (!runtimeWork || !address) return null
  const workspaces = [
    ...runtimeWork.chats,
    ...runtimeWork.projects.flatMap(project => project.deviceWorkspaces),
  ]

  for (const workspace of workspaces) {
    if (workspace.deviceId !== address.deviceId) continue
    const task = workspace.tasks.find(item => item.taskId === address.taskId)
    if (task) return task
  }

  return null
}

export function getRememberedStandaloneDeviceId(
  user: User,
  devices: DeviceInfo[],
  fallbackDeviceId?: string | null
) {
  return getPreferredStandaloneDeviceId(
    devices,
    user.preferences?.default_execution_target ?? fallbackDeviceId
  )
}

function getSelectableProjectDeviceWorkspaces(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): RuntimeDeviceWorkspace[] {
  return getProjectDeviceWorkspaces(runtimeWork, projectId).filter(workspace => workspace.available)
}

function getProjectDeviceWorkspaces(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): RuntimeDeviceWorkspace[] {
  if (!projectId) return []
  const projectWork = runtimeWork?.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
  return projectWork?.deviceWorkspaces ?? []
}

export function getSingleProjectDeviceWorkspaceId(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined
): number | null {
  const workspaces = getSelectableProjectDeviceWorkspaces(runtimeWork, projectId)
  return workspaces.length === 1 ? (workspaces[0].id ?? null) : null
}

export function findSelectableProject(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number
): ProjectWithTasks | null {
  const project = projects.find(item => item.id === projectId)
  if (project) return project
  const runtimeProject = runtimeWork?.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
  return runtimeProject ? runtimeProjectToProject(runtimeProject) : null
}

export function findProjectDeviceWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined,
  deviceWorkspaceId: number | null | undefined
): RuntimeDeviceWorkspace | null {
  const workspaces = getSelectableProjectDeviceWorkspaces(runtimeWork, projectId)
  if (deviceWorkspaceId) {
    return workspaces.find(workspace => workspace.id === deviceWorkspaceId) ?? null
  }
  return workspaces.length === 1 ? workspaces[0] : null
}

export function findProjectMetadataDeviceWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined,
  deviceWorkspaceId: number | null | undefined
): RuntimeDeviceWorkspace | null {
  const workspaces = getProjectDeviceWorkspaces(runtimeWork, projectId)
  if (deviceWorkspaceId) {
    return workspaces.find(workspace => workspace.id === deviceWorkspaceId) ?? null
  }
  return workspaces.length === 1 ? workspaces[0] : null
}

const MARKDOWN_MENTION_PATTERN = /\[([^\]]+)]\(([^)]+)\)/g

function runtimeTitleText(value: string): string {
  return value
    .replace(MARKDOWN_MENTION_PATTERN, (_match, label: string) => label)
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildRuntimeTaskTitle(message: string, fallback?: string): string {
  const title = runtimeTitleText(fallback || message)
  return title ? title.slice(0, 100) : EMPTY_MESSAGE_TASK_TITLE
}

function stableRuntimeTaskId(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return (hash % 1_000_000_000) + 1
}

export function createRuntimeTaskIdFromSeed(seed: string): string {
  return `runtime-${stableRuntimeTaskId(seed)}`
}

export function createRuntimeTaskId(runtime: RuntimeTaskCreateRequest['runtime']): string {
  const prefix = runtime === 'codex' ? 'codex' : 'runtime'
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${randomId}`
}
