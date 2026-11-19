import type { KeyboardEvent } from 'react'

import { type ActionMenuItem } from '@/components/common/ActionMenu'

import { DshIcon } from '@/features/dsh-runtime/DshIcon'

import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'

import { getRuntimeTaskLifecycleKey } from '@/features/workbench/runtimeTaskLifecycle'

import { useTranslation } from '@/hooks/useTranslation'
import {
  canUseForProjectCreation,
  isCloudDevice,
  isClaudeCodeDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'

import { standaloneRuntimeProjectKey } from '@/lib/runtime-project'

import type {
  DeviceInfo,
  RuntimeTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectWork,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'

import { getWorkbenchPaneKey } from './workbenchPaneIdentity'

import { type ProjectHoverSource } from './ProjectSidebarHoverCardContent'

import {
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  shortenSidebarHomePath,
} from './runtimeTaskSidebarHelpers'

import type { WorkbenchSplitGroupMembership } from './workbenchSplitGroups'
import type {
  RuntimeTaskPriorityReason,
  SidebarDeviceStatus,
  SidebarDeviceState,
} from './desktopSidebarTypes'
export const EMPTY_RUNTIME_TASK_KEYS: ReadonlySet<string> = new Set()

export const EMPTY_SPLIT_GROUP_MEMBERSHIPS: Readonly<
  Record<string, WorkbenchSplitGroupMembership>
> = {}

export const PROJECT_APPEARANCE_COLORS = [
  'blue',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
  'black',
] as const

export const PROJECT_APPEARANCE_COLOR_VALUES: Record<string, string> = {
  black: '#4b5563',
  blue: '#3b82f6',
  green: '#22c55e',
  orange: '#f97316',
  pink: '#ec4899',
  purple: '#a855f7',
  red: '#ef4444',
  yellow: '#eab308',
}

export function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name?.trim() || ''
}

export function normalizeSidebarWorkspacePath(path: string): string {
  const trimmedPath = path.trim()
  if (trimmedPath === '/') return trimmedPath
  return trimmedPath.replace(/\/+$/, '')
}

export function getSidebarPathBasename(path: string): string {
  const normalizedPath = normalizeSidebarWorkspacePath(path)
  const parts = normalizedPath.split('/').filter(Boolean)
  return parts.at(-1) ?? normalizedPath
}

export function runtimeWorkHasWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  workspacePath: string
): boolean {
  const normalizedPath = normalizeSidebarWorkspacePath(workspacePath)
  const hasMatchingWorkspace = (workspace: RuntimeDeviceWorkspace) =>
    normalizeSidebarWorkspacePath(workspace.workspacePath) === normalizedPath

  return (
    (runtimeWork?.projects ?? []).some(projectWork =>
      projectWork.deviceWorkspaces.some(hasMatchingWorkspace)
    ) || (runtimeWork?.chats ?? []).some(hasMatchingWorkspace)
  )
}

export function standaloneRuntimeProjectWork(
  devices: DeviceInfo[],
  deviceId: string | null | undefined,
  workspacePath: string | null | undefined,
  runtimeWork: RuntimeWorkListResponse | null | undefined
): RuntimeProjectWork | null {
  const normalizedDeviceId = deviceId?.trim()
  const normalizedWorkspacePath = workspacePath ? normalizeSidebarWorkspacePath(workspacePath) : ''
  if (!normalizedDeviceId || !normalizedWorkspacePath) return null
  if (runtimeWorkHasWorkspace(runtimeWork, normalizedWorkspacePath)) {
    return null
  }

  const deviceState = getSidebarDeviceState(normalizedDeviceId, devices)
  const device = deviceState?.device
  const resolvedDeviceId = deviceState?.deviceId ?? normalizedDeviceId
  const deviceStatus = deviceState?.status ?? 'unavailable'
  return {
    project: {
      key: standaloneRuntimeProjectKey(normalizedWorkspacePath),
      stateDeviceId: resolvedDeviceId,
      name: getSidebarPathBasename(normalizedWorkspacePath),
      description: normalizedWorkspacePath,
      color: null,
    },
    deviceWorkspaces: [
      {
        id: null,
        projectId: null,
        deviceId: resolvedDeviceId,
        deviceName: device ? getStandaloneDeviceLabel(device) || null : null,
        deviceStatus,
        available: deviceStatus === 'online' || deviceStatus === 'busy',
        workspacePath: normalizedWorkspacePath,
        workspaceKind: 'workspace',
        worktreeId: null,
        mapped: true,
        tasks: [],
      },
    ],
  }
}

export const SIDEBAR_ROW_METADATA_CLASS =
  'flex items-center gap-1 text-xs text-[rgb(var(--color-sidebar-text-muted))] group-hover/task:invisible group-focus-visible/task:invisible group-has-[:focus-visible]/task:invisible'

export const SIDEBAR_HEADER_ICON_BUTTON_CLASS =
  'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] active:bg-[rgb(var(--color-sidebar-active))]'

export const SIDEBAR_DEVICE_COLORS = [
  '#5B7CFA',
  '#3FA67A',
  '#C9892B',
  '#8F6DD8',
  '#C65D5D',
  '#339DA0',
  '#B35EA4',
  '#6F9B4B',
] as const

export function getSidebarDeviceColorKey(
  deviceName: string | null | undefined,
  deviceId: string | null | undefined
): string {
  return deviceName?.trim() || deviceId?.trim() || 'device'
}

export function getSidebarDeviceColor(colorKey: string): string {
  let hash = 0

  for (let index = 0; index < colorKey.length; index += 1) {
    hash = (hash * 31 + colorKey.charCodeAt(index)) >>> 0
  }

  return SIDEBAR_DEVICE_COLORS[hash % SIDEBAR_DEVICE_COLORS.length]
}

export function getDesktopSidebarStorageScope(user: UserProfile | null): string {
  return user?.id ? String(user.id) : 'anonymous'
}

export function pruneProjectIdSet(values: Set<number>, projects: ProjectWithTasks[]): Set<number> {
  if (projects.length === 0) return values
  const projectIds = new Set(projects.map(project => project.id))
  return new Set([...values].filter(projectId => projectIds.has(projectId)))
}

export function handleSidebarRowKeyDown(event: KeyboardEvent<HTMLDivElement>, onOpen: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return

  event.preventDefault()
  onOpen()
}

export function getProjectDeviceId(project: ProjectWithTasks): string | undefined {
  return project.config?.execution?.deviceId ?? project.config?.device_id
}

export function getSidebarDeviceState(
  deviceId: string | null | undefined,
  devices: DeviceInfo[]
): SidebarDeviceState | null {
  if (!deviceId) return null

  const device =
    devices.find(item =>
      [
        item.device_id,
        item.app_device_id,
        item.socket_device_id,
        ...(item.runtime_routes ?? []).map(route => route.device_id),
      ].includes(deviceId)
    ) ??
    (deviceId === 'local-device'
      ? (devices.find(item => item.device_type === 'local' && item.status === 'online') ??
        devices.find(item => item.device_type === 'local') ??
        null)
      : null)
  return {
    deviceId: device?.device_id ?? deviceId,
    device: device ?? undefined,
    status: device?.status ?? 'unavailable',
  }
}

export function isSidebarDeviceOnline(deviceState: SidebarDeviceState | null): boolean {
  return !deviceState || deviceState.status === 'online'
}

export function getSidebarDeviceName(deviceState: SidebarDeviceState): string {
  return deviceState.device?.name.trim() || ''
}

export function hasCloudRuntimeRoute(device?: DeviceInfo): boolean {
  return Boolean(
    device?.runtime_routes?.some(
      route => route.kind === 'cloud-relay' || route.kind === 'remote-relay'
    )
  )
}

export function getDeviceRouteLabel(deviceState: SidebarDeviceState): string {
  const deviceName = deviceState.device?.name?.trim()
  if (deviceName) return deviceName
  return ''
}

export function getDeviceRouteTitle(deviceState: SidebarDeviceState): string {
  const routes = deviceState.device?.runtime_routes
  if (!routes?.length) return getDeviceRouteLabel(deviceState)
  return routes.map(route => `${route.kind}: ${route.device_id}`).join('\n')
}

export function getRuntimeProjectDeviceState(
  runtimeProjectWork: RuntimeProjectWork | undefined,
  devices: DeviceInfo[]
): SidebarDeviceState | null {
  const workspace = runtimeProjectWork?.deviceWorkspaces[0]
  if (!workspace) return null
  const resolvedDevice = getSidebarDeviceState(workspace.deviceId, devices)
  if (resolvedDevice?.device) return resolvedDevice
  return {
    deviceId: workspace.deviceId,
    status: (workspace.deviceStatus ??
      resolvedDevice?.status ??
      'unavailable') as SidebarDeviceStatus,
  }
}

export function isRuntimeWorkspaceOffline(
  workspace: RuntimeDeviceWorkspace,
  devices: DeviceInfo[]
): boolean {
  const resolvedDevice = getSidebarDeviceState(workspace.deviceId, devices)
  const status = resolvedDevice?.device ? resolvedDevice.status : workspace.deviceStatus
  return status === 'offline'
}

export function filterOfflineRuntimeProjectWorkspaces(
  projects: RuntimeProjectWork[],
  devices: DeviceInfo[]
): RuntimeProjectWork[] {
  return projects.flatMap(projectWork => {
    const deviceWorkspaces = projectWork.deviceWorkspaces.filter(
      workspace => !isRuntimeWorkspaceOffline(workspace, devices)
    )
    return deviceWorkspaces.length > 0 ? [{ ...projectWork, deviceWorkspaces }] : []
  })
}

export function isRuntimeRemoteProject(
  runtimeProjectWork: RuntimeProjectWork | undefined
): boolean {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  return (
    workspaces.length > 0 && workspaces.every(workspace => workspace.workspaceSource === 'remote')
  )
}

export function getSidebarRepositoryLabel(repoUrl?: string | null): string | null {
  const value = repoUrl?.trim()
  if (!value) return null
  const normalized = value.replace(/\.git$/u, '').replace(/\/+$/u, '')
  const sshMatch = normalized.match(/^[^@]+@[^:]+:(.+)$/u)
  const path = sshMatch?.[1] ?? normalized.replace(/^[a-z]+:\/\/[^/]+\//iu, '')
  const parts = path.split('/').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : parts[0] || value
}

export function getRuntimeTaskRepositoryLabel(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): string | null {
  const taskRepoUrl = getRuntimeTaskGitInfoValue(task, [
    'originUrl',
    'origin_url',
    'repoUrl',
    'repo_url',
  ])
  return getSidebarRepositoryLabel(
    workspace.repoUrl || (typeof taskRepoUrl === 'string' ? taskRepoUrl : null)
  )
}

export function getRuntimeTaskGitInfoValue(task: RuntimeTaskSummary, keys: string[]): unknown {
  if (!task.gitInfo || typeof task.gitInfo !== 'object') return undefined
  return keys.map(key => task.gitInfo?.[key]).find(value => value !== undefined && value !== null)
}

export function getRuntimeTaskBranch(task: RuntimeTaskSummary): string | null {
  const branch = getRuntimeTaskGitInfoValue(task, ['branch', 'branchName', 'branch_name'])
  return typeof branch === 'string' && branch.trim() ? branch.trim() : null
}

export function hasRuntimeTaskBranchWarning(task: RuntimeTaskSummary): boolean {
  const taskBranch = getRuntimeTaskBranch(task)
  const currentBranch = getRuntimeTaskGitInfoValue(task, ['currentBranch', 'current_branch'])
  if (taskBranch && typeof currentBranch === 'string' && currentBranch.trim()) {
    return taskBranch !== currentBranch.trim()
  }
  return (
    getRuntimeTaskGitInfoValue(task, [
      'branchMismatch',
      'branch_mismatch',
      'isBranchOutdated',
      'is_branch_outdated',
    ]) === true
  )
}

export function isRuntimeTaskWaiting(task: RuntimeTaskSummary): boolean {
  // The lifecycle store owns explicit interaction metadata and may already have
  // accepted a reply newer than this task-list snapshot.
  if (task.interactionStatus !== undefined) return false
  const status = task.status?.trim().toLowerCase() ?? ''
  return ['waiting', 'approval', 'input', 'attention', 'blocked'].some(value =>
    status.includes(value)
  )
}

export function getRuntimeTaskPriorityReason(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary,
  unreadTaskKeys: ReadonlySet<string>,
  runningTaskKeys: ReadonlySet<string>,
  waitingTaskKeys: ReadonlySet<string>
): RuntimeTaskPriorityReason | null {
  if (unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))) return 'unread'
  const address = getRuntimeTaskAddress(workspace, task)
  const lifecycleKey = getRuntimeTaskLifecycleKey(address)
  if (waitingTaskKeys.has(lifecycleKey) || isRuntimeTaskWaiting(task)) return 'waiting'
  if (runningTaskKeys.has(lifecycleKey)) return 'active'
  return null
}

export function getRuntimeTaskPriorityRank(reason: RuntimeTaskPriorityReason): number {
  switch (reason) {
    case 'unread':
      return 0
    case 'waiting':
      return 1
    case 'active':
      return 2
  }
}

export function getRuntimeTaskSplitGroup(
  memberships: Readonly<Record<string, WorkbenchSplitGroupMembership>>,
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): WorkbenchSplitGroupMembership | undefined {
  return memberships[
    getWorkbenchPaneKey({
      currentRuntimeTask: getRuntimeTaskAddress(workspace, task),
      currentProject: null,
    })
  ]
}

export function getRuntimeTaskPriorityTime(task: RuntimeTaskSummary): number {
  const value = getRuntimeTaskTime(task)
  if (value === undefined) return 0
  const numeric = typeof value === 'number' ? value : Number(value)
  const timestamp = Number.isFinite(numeric) ? numeric : new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function getRuntimeTaskSortableId(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): string {
  return `${workspace.deviceId}:${task.taskId}`
}

export function getProjectHoverSources(
  runtimeProjectWork: RuntimeProjectWork | undefined,
  devices: DeviceInfo[],
  localDeviceLabel: string,
  finderWorkspacePath: string | null,
  openFinder: (path: string) => void,
  openFinderLabel: (path: string) => string
): ProjectHoverSource[] {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  const sources: ProjectHoverSource[] = []
  const seen = new Set<string>()
  const add = (source: ProjectHoverSource) => {
    const key = `${source.kind}\0${source.value}\0${source.detail ?? ''}`
    if (!source.value || seen.has(key)) return
    seen.add(key)
    sources.push(source)
  }

  for (const workspace of workspaces) {
    const device = getSidebarDeviceState(workspace.deviceId, devices)?.device
    const deviceName =
      device?.device_type === 'local'
        ? localDeviceLabel
        : device?.name?.trim() || workspace.deviceName?.trim()
    const deviceId =
      workspace.remoteHostId?.trim() || device?.device_id?.trim() || workspace.deviceId.trim()
    if (deviceName && deviceName !== workspace.deviceId) {
      add({
        id: `host:${workspace.deviceId}`,
        kind: 'host',
        value: deviceName,
        detail: deviceId && deviceId !== deviceName ? deviceId : undefined,
      })
    }
  }

  const roots = runtimeProjectWork?.project.roots?.length
    ? runtimeProjectWork.project.roots.map(root => root.path)
    : workspaces.length > 0
      ? workspaces.map(workspace => workspace.workspacePath)
      : finderWorkspacePath
        ? [finderWorkspacePath]
        : []
  for (const path of roots) {
    const normalizedPath = path.trim()
    if (!normalizedPath) continue
    const canOpen = finderWorkspacePath === normalizedPath
    add({
      id: `path:${normalizedPath}`,
      kind: 'path',
      value: shortenSidebarHomePath(normalizedPath),
      actionLabel: canOpen ? openFinderLabel(normalizedPath) : undefined,
      onOpen: canOpen ? () => openFinder(normalizedPath) : undefined,
    })
  }
  return sources
}

export function isLocalProjectFinderDevice(device: DeviceInfo | undefined): device is DeviceInfo {
  if (!device) return false

  return (
    !isCloudDevice(device) &&
    !isRemoteDevice(device) &&
    isClaudeCodeDevice(device) &&
    canUseForProjectCreation(device)
  )
}

export function getProjectFinderWorkspacePath(
  project: ProjectWithTasks,
  runtimeProjectWork: RuntimeProjectWork | undefined,
  devices: DeviceInfo[]
): string | null {
  const runtimeWorkspace = runtimeProjectWork?.deviceWorkspaces.find(workspace => {
    const workspacePath = workspace.workspacePath.trim()
    const device = devices.find(item => item.device_id === workspace.deviceId)
    return Boolean(workspacePath) && isLocalProjectFinderDevice(device)
  })
  if (runtimeWorkspace) return runtimeWorkspace.workspacePath.trim()

  const projectWorkspacePath = project.config?.workspace?.localPath?.trim()
  const projectDevice = devices.find(item => item.device_id === getProjectDeviceId(project))
  if (projectWorkspacePath && isLocalProjectFinderDevice(projectDevice)) {
    return projectWorkspacePath
  }

  return null
}

export function shouldShowProjectDeviceStatus(
  deviceState: SidebarDeviceState | null,
  devices: DeviceInfo[],
  remoteProject: boolean
): deviceState is SidebarDeviceState {
  if (!deviceState) return false
  if (remoteProject) return true
  if (hasCloudRuntimeRoute(deviceState.device) && deviceState.device?.device_type !== 'local') {
    return true
  }
  if (devices.length <= 1) return false
  return Boolean(
    deviceState.device && (isCloudDevice(deviceState.device) || isRemoteDevice(deviceState.device))
  )
}

export function getRuntimeWorkspaceDeviceColor(workspace: RuntimeDeviceWorkspace): string {
  return getSidebarDeviceColor(getSidebarDeviceColorKey(workspace.deviceName, workspace.deviceId))
}

export function getSidebarDeviceStatusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  status: SidebarDeviceStatus
) {
  if (status === 'online') {
    return t('workbench.project_device_status_online', '在线')
  }
  if (status === 'busy') {
    return t('workbench.project_device_status_busy', '忙碌')
  }
  if (status === 'offline') {
    return t('workbench.project_device_status_offline', '离线')
  }
  return t('workbench.project_device_status_unavailable', '不可用')
}

export function getRuntimeNotificationKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}\0${address.workspacePath ?? ''}`
}

export function isRuntimeTaskNotificationSubscribed(
  settings: RuntimeIMNotificationSettingsResponse | null | undefined,
  address: RuntimeTaskAddress
): boolean {
  const key = getRuntimeNotificationKey(address)
  return Boolean(
    settings?.runtimeTaskSubscriptions?.some(
      subscription => getRuntimeNotificationKey(subscription.address) === key
    )
  )
}

export function formatSidebarTemplate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template
  )
}

export function getDeviceUnavailableActionTitle(
  t: ReturnType<typeof useTranslation>['t'],
  deviceState: SidebarDeviceState
) {
  const status = getSidebarDeviceStatusLabel(t, deviceState.status)
  return formatSidebarTemplate(
    t('workbench.project_chat_device_unavailable', '设备{{status}}，无法问AI：{{device}}'),
    { status, device: getSidebarDeviceName(deviceState) }
  )
}

export function dshMenuItemIcon(name?: string): ActionMenuItem['icon'] {
  if (!name) return undefined
  const Icon = ({ className }: { className?: string }) => (
    <DshIcon name={name} className={className} />
  )
  return Icon
}
