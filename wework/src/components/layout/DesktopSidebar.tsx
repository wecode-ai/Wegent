import {
  Archive,
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
  FolderOpen,
  FolderPlus,
  Globe2,
  GitCompareArrows,
  Grid3X3,
  Loader2,
  MessageSquarePlus,
  Pin,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent,
  PointerEventHandler,
  ReactNode,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import { SHOW_PLUGINS_NAVIGATION } from '@/features/plugins/visibility'
import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import { CloudConnectionSidebarButton } from '@/features/cloud-connection/CloudConnectionSidebarButton'
import { isCloudConnectionUiAvailable } from '@/features/cloud-connection/cloudConnectionAvailability'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import {
  StandaloneBlankProjectDialog,
  StandaloneFolderProjectDialog,
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { useWindowFocus } from '@/hooks/useWindowFocus'
import { getRuntimeConfig } from '@/config/runtime'
import {
  canUseForProjectCreation,
  isCloudDevice,
  isClaudeCodeDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { navigateTo } from '@/lib/navigation'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import {
  runtimeProjectToProject,
  runtimeProjectUiId,
  standaloneRuntimeProjectKey,
} from '@/lib/runtime-project'
import {
  getLocalRuntimeStateDeviceId,
  getRuntimeProjectReorderRequest,
  getRuntimeProjectSidebarStateKey,
} from '@/lib/runtime-project-state'
import { cn } from '@/lib/utils'
import {
  defaultAppearance,
  getWorkbenchBackground,
  useOptionalAppearance,
} from '@/features/appearance'
import type {
  DeviceInfo,
  RuntimeTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectWork,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeTaskPinRequest,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudWorkStatus } from '@/types/workbench'
import type {
  ArchiveRuntimeConversationsResult,
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'
import { DesktopWindowControls } from './DesktopWindowControls'
import { DesktopAppSwitcher } from './DesktopAppSwitcher'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import { SidebarSortableList } from './SidebarSortableList'
import { SidebarHoverCard } from './SidebarHoverCard'
import {
  ProjectSidebarHoverCardContent,
  type ProjectHoverSource,
} from './ProjectSidebarHoverCardContent'
import { TaskSidebarHoverCardContent } from './TaskSidebarHoverCardContent'
import {
  getRuntimeChatSidebarTaskItems,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  getRuntimeTaskWorkspaceTitle,
  getRuntimeSidebarTaskItems,
  getVisibleRuntimeSidebarTaskItems,
  hasExpandedRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  isRuntimeTaskSelected,
  isRuntimeWorktreeTask,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'
import {
  debugRuntimeSidebarState,
  warnRuntimeSidebarMismatch,
} from '@/features/workbench/runtimeSidebarDiagnostics'
import { formatRelativeSidebarTime, useSidebarRelativeTimeRefresh } from './runtimeSidebarTime'
import { useResizableSidebar } from './useResizableSidebar'

interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  cloudWorkStatus?: CloudWorkStatus
  runtimeWork?: RuntimeWorkListResponse | null
  currentRuntimeTask?: RuntimeTaskAddress | null
  standaloneDeviceId?: string | null
  standaloneWorkspacePath?: string | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  unreadRuntimeTaskKeys?: ReadonlySet<string>
  preferredDeviceId?: string | null
  activeItem?: 'chat' | 'todo' | 'plugins' | 'sites' | 'automation'
  collapsed?: boolean
  containerTestId?: string
  hideResizeHandle?: boolean
  sidebarWidth?: number
  resizing?: boolean
  onResizeStart?: (event: PointerEvent<HTMLButtonElement>) => void
  onResizeCollapse?: () => void
  onResizeStateChange?: (resizing: boolean) => void
  onPointerEnter?: PointerEventHandler<HTMLElement>
  onPointerLeave?: PointerEventHandler<HTMLElement>
  onToggleSidebar?: () => void
  onOpenWorkbench?: () => void
  onOpenTodo?: () => void
  onOpenApps?: () => void
  onNewChat: () => void
  onStartStandaloneChat: () => void
  onOpenSearch?: () => void
  onSelectProject?: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onRenameRuntimeTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onArchiveProjectConversations?: (
    runtimeProjectKey: string,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onArchiveProjectsConversations?: (
    runtimeProjectKeys: string[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onArchiveChatConversations?: (
    addresses: RuntimeTaskAddress[],
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
  onToggleGlobalImNotification?: () => Promise<void> | void
  onOpenGlobalImNotificationSettings?: () => Promise<void> | void
  onOpenPlugins: () => void
  onOpenSites?: () => void
  onRefreshDevices?: () => Promise<void>
  onOpenBlankStandaloneProject?: () => void
  onOpenStandaloneFolderProject?: (
    mode: StandaloneWorkspaceDialogMode,
    intent?: StandaloneRemoteDialogIntent
  ) => void
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string
  ) => Promise<void> | void
  onCreatePermanentWorktree?: (data: {
    deviceId: string
    sourcePath: string
    name: string
  }) => Promise<void>
  onSelectStandaloneDevice?: (deviceId: string | null) => void
  onGetRemoteDeviceStartupCommand?: () => Promise<DockerRemoteDeviceCommandResponse>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onReorderRuntimeProjects?: (data: RuntimeProjectReorderRequest) => Promise<void>
  onSetRuntimeProjectPinned?: (data: RuntimeProjectPinRequest) => Promise<void>
  onSetRuntimeProjectAppearance?: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  onReorderRuntimeProjectTasks?: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenSettings: (options?: OpenSettingsOptions) => void
  onLogout: () => void
}

interface RuntimeTaskPinOverride {
  base: boolean
  value: boolean
  requestId: number
  source: RuntimeWorkListResponse | null | undefined
}

function getRuntimeTaskPinOverrideKey(deviceId: string, threadId: string) {
  return `${deviceId}\0${threadId}`
}

interface OpenSettingsOptions {
  autoOpenAddCloudDeviceDialog?: boolean
  settingsPage?: 'connections'
}

type ProjectCreateMenuPosition = {
  top: number
  left: number
}

interface ArchiveConversationsConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  submitting: boolean
  testId: string
  onClose: () => void
  onConfirm: () => Promise<void> | void
}

const PROJECT_CREATE_MENU_WIDTH = 248
const PROJECT_CREATE_MENU_MARGIN = 8
const RUNTIME_ARCHIVE_UNDO_DELAY_MS = 3000
const PROJECT_APPEARANCE_COLORS = [
  'blue',
  'green',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
  'black',
] as const
const PROJECT_APPEARANCE_COLOR_VALUES: Record<string, string> = {
  black: '#4b5563',
  blue: '#3b82f6',
  green: '#22c55e',
  orange: '#f97316',
  pink: '#ec4899',
  purple: '#a855f7',
  red: '#ef4444',
  yellow: '#eab308',
}
const MACOS_WINDOW_CONTROLS_SAFE_AREA_CLASS = 'left-[92px]'

function getSidebarAccountSummary(user: UserProfile | null, fallback: string) {
  const userName = user?.user_name?.trim()
  const email = user?.email?.trim()
  const label = userName || email || fallback
  const detail = email && email !== label ? email : fallback
  return {
    label,
    detail,
  }
}

function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name || device.device_id
}

function normalizeSidebarWorkspacePath(path: string): string {
  const trimmedPath = path.trim()
  if (trimmedPath === '/') return trimmedPath
  return trimmedPath.replace(/\/+$/, '')
}

function getSidebarPathBasename(path: string): string {
  const normalizedPath = normalizeSidebarWorkspacePath(path)
  const parts = normalizedPath.split('/').filter(Boolean)
  return parts.at(-1) ?? normalizedPath
}

function runtimeWorkHasWorkspace(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  deviceId: string,
  workspacePath: string
): boolean {
  const normalizedPath = normalizeSidebarWorkspacePath(workspacePath)
  return (runtimeWork?.projects ?? []).some(projectWork =>
    projectWork.deviceWorkspaces.some(
      workspace =>
        workspace.deviceId === deviceId &&
        normalizeSidebarWorkspacePath(workspace.workspacePath) === normalizedPath
    )
  )
}

function standaloneRuntimeProjectWork(
  devices: DeviceInfo[],
  deviceId: string | null | undefined,
  workspacePath: string | null | undefined,
  runtimeWork: RuntimeWorkListResponse | null | undefined
): RuntimeProjectWork | null {
  const normalizedDeviceId = deviceId?.trim()
  const normalizedWorkspacePath = workspacePath ? normalizeSidebarWorkspacePath(workspacePath) : ''
  if (!normalizedDeviceId || !normalizedWorkspacePath) return null
  if (runtimeWorkHasWorkspace(runtimeWork, normalizedDeviceId, normalizedWorkspacePath)) {
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
        deviceName: device ? getStandaloneDeviceLabel(device) : resolvedDeviceId,
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

function ArchiveConversationsConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  submitting,
  testId,
  onClose,
  onConfirm,
}: ArchiveConversationsConfirmDialogProps) {
  useEscapeKey(onClose, open && !submitting)

  if (!open) return null

  return createPortal(
    <div
      data-testid={`${testId}-overlay`}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        className="w-full max-w-[460px] rounded-xl border border-border bg-popover p-5 text-text-primary shadow-[0_20px_56px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-start justify-between gap-5">
          <h2 id={`${testId}-title`} className="heading-base tracking-normal">
            {title}
          </h2>
          <button
            type="button"
            data-testid={`${testId}-close-button`}
            onClick={onClose}
            disabled={submitting}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={cancelLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-3 text-sm leading-6 text-text-secondary">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid={`${testId}-cancel-button`}
            onClick={onClose}
            disabled={submitting}
            className="h-8 min-w-[76px] rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm-button`}
            onClick={() => void onConfirm()}
            disabled={submitting}
            className="inline-flex h-8 min-w-[96px] items-center justify-center gap-2 rounded-lg bg-red-500/15 px-4 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

const SIDEBAR_ROW_METADATA_CLASS =
  'flex items-center gap-1 text-xs text-[rgb(var(--color-sidebar-text-muted))] group-hover/task:invisible'
const SIDEBAR_RUNNING_SPINNER_CLASS =
  'h-4 w-4 shrink-0 animate-spin text-[rgb(var(--color-sidebar-text-muted))]'

const SIDEBAR_DEVICE_COLORS = [
  '#5B7CFA',
  '#3FA67A',
  '#C9892B',
  '#8F6DD8',
  '#C65D5D',
  '#339DA0',
  '#B35EA4',
  '#6F9B4B',
] as const

function getSidebarDeviceColorKey(
  deviceName: string | null | undefined,
  deviceId: string | null | undefined
): string {
  return deviceName?.trim() || deviceId?.trim() || 'device'
}

function getSidebarDeviceColor(colorKey: string): string {
  let hash = 0

  for (let index = 0; index < colorKey.length; index += 1) {
    hash = (hash * 31 + colorKey.charCodeAt(index)) >>> 0
  }

  return SIDEBAR_DEVICE_COLORS[hash % SIDEBAR_DEVICE_COLORS.length]
}

function SidebarButton({
  icon: Icon,
  label,
  testId,
  selected,
  onClick,
}: {
  icon: typeof Plus
  label: string
  testId: string
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
      className={[
        'flex h-[30px] w-full items-center gap-2 rounded-[10px] px-2 text-left text-base font-normal leading-5',
        selected
          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 text-current" />
      <span>{label}</span>
    </button>
  )
}

const DESKTOP_SIDEBAR_STORAGE_PREFIX = 'wework.desktop.sidebar'

function getDesktopSidebarStorageScope(user: UserProfile | null): string {
  return user?.id ? String(user.id) : 'anonymous'
}

function getDesktopSidebarStorageKey(scope: string, key: string): string {
  return `${DESKTOP_SIDEBAR_STORAGE_PREFIX}.${key}.${scope}`
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key)
    if (value === null) return fallback
    return value === 'true'
  } catch {
    return fallback
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false')
  } catch {
    // Keep the in-memory sidebar state when browser storage is unavailable.
  }
}

function readStoredNumberSet(key: string): Set<number> {
  try {
    const value = window.localStorage.getItem(key)
    if (!value) return new Set()
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is number => Number.isInteger(item) && item > 0))
  } catch {
    return new Set()
  }
}

function writeStoredNumberSet(key: string, values: Set<number>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values].sort((a, b) => a - b)))
  } catch {
    // Keep the in-memory sidebar state when browser storage is unavailable.
  }
}

function pruneProjectIdSet(values: Set<number>, projects: ProjectWithTasks[]): Set<number> {
  if (projects.length === 0) return values
  const projectIds = new Set(projects.map(project => project.id))
  return new Set([...values].filter(projectId => projectIds.has(projectId)))
}

function handleSidebarRowKeyDown(event: KeyboardEvent<HTMLDivElement>, onOpen: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return

  event.preventDefault()
  onOpen()
}

function SidebarSectionHeader({
  title,
  expanded,
  hasContent,
  toggleTestId,
  iconTestId,
  onToggle,
  children,
}: {
  title: string
  expanded: boolean
  hasContent: boolean
  toggleTestId: string
  iconTestId: string
  onToggle: () => void
  children: ReactNode
}) {
  const iconVisibilityClass =
    hasContent && !expanded ? 'opacity-100' : 'opacity-0 group-hover/section:opacity-100'

  return (
    <div className="group/section relative mb-2 flex h-[30px] items-center px-2.5">
      <button
        type="button"
        data-testid={toggleTestId}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md pr-8 text-left"
      >
        <span className="truncate text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
          {title}
        </span>
        <ChevronRight
          data-testid={iconTestId}
          className={cn(
            'h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))] transition-[opacity,transform]',
            expanded ? 'rotate-90' : 'rotate-0',
            iconVisibilityClass
          )}
        />
      </button>
      <div
        data-testid={`${toggleTestId}-actions`}
        className="pointer-events-none absolute right-2.5 top-1/2 z-[70] flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/section:pointer-events-auto group-hover/section:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      >
        {children}
      </div>
    </div>
  )
}

type SidebarDeviceStatus = DeviceInfo['status'] | 'unavailable'

interface SidebarDeviceState {
  deviceId: string
  device?: DeviceInfo
  status: SidebarDeviceStatus
}

function getProjectDeviceId(project: ProjectWithTasks): string | undefined {
  return project.config?.execution?.deviceId ?? project.config?.device_id
}

function getSidebarDeviceState(
  deviceId: string | null | undefined,
  devices: DeviceInfo[]
): SidebarDeviceState | null {
  if (!deviceId) return null

  const device =
    devices.find(item => item.device_id === deviceId) ??
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

function isSidebarDeviceOnline(deviceState: SidebarDeviceState | null): boolean {
  return !deviceState || deviceState.status === 'online'
}

function getSidebarDeviceName(deviceState: SidebarDeviceState): string {
  return deviceState.device?.name || deviceState.deviceId
}

function getDeviceNetworkLabel(device?: DeviceInfo): string | null {
  const runtimeTransferHost = getDisplayableNetworkHost(device?.runtime_transfer_host)
  if (runtimeTransferHost) return runtimeTransferHost
  return getDisplayableNetworkHost(device?.client_ip)
}

function hasCloudRuntimeRoute(device?: DeviceInfo): boolean {
  return Boolean(
    device?.runtime_routes?.some(
      route => route.kind === 'cloud-relay' || route.kind === 'remote-relay'
    )
  )
}

function getDeviceRouteLabel(deviceState: SidebarDeviceState): string {
  return getDeviceNetworkLabel(deviceState.device) || deviceState.deviceId
}

function getDeviceRouteTitle(deviceState: SidebarDeviceState): string {
  const routes = deviceState.device?.runtime_routes
  if (!routes?.length) return getDeviceRouteLabel(deviceState)
  return routes.map(route => `${route.kind}: ${route.device_id}`).join('\n')
}

function getDisplayableNetworkHost(value?: string | null): string | null {
  if (!value) return null
  return extractNetworkHost(value.trim()) || null
}

function extractNetworkHost(value: string): string {
  const bracketMatch = value.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]
  const colonParts = value.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }
  return value
}

function getRuntimeProjectDeviceState(
  runtimeProjectWork: RuntimeProjectWork | undefined,
  devices: DeviceInfo[]
): SidebarDeviceState | null {
  const workspace = runtimeProjectWork?.deviceWorkspaces[0]
  if (!workspace) return null
  const resolvedDevice = getSidebarDeviceState(workspace.deviceId, devices)
  if (resolvedDevice?.device) return resolvedDevice
  return {
    deviceId: workspace.deviceName || workspace.remoteHostId || workspace.deviceId,
    status: (workspace.deviceStatus ??
      resolvedDevice?.status ??
      'unavailable') as SidebarDeviceStatus,
  }
}

function isRuntimeRemoteProject(runtimeProjectWork: RuntimeProjectWork | undefined): boolean {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  return (
    workspaces.length > 0 && workspaces.every(workspace => workspace.workspaceSource === 'remote')
  )
}

function shortenSidebarHomePath(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/u, '~')
}

function getSidebarRepositoryLabel(repoUrl?: string | null): string | null {
  const value = repoUrl?.trim()
  if (!value) return null
  const normalized = value.replace(/\.git$/u, '').replace(/\/+$/u, '')
  const sshMatch = normalized.match(/^[^@]+@[^:]+:(.+)$/u)
  const path = sshMatch?.[1] ?? normalized.replace(/^[a-z]+:\/\/[^/]+\//iu, '')
  const parts = path.split('/').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : parts[0] || value
}

function getRuntimeTaskRepositoryLabel(
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

function getRuntimeTaskGitInfoValue(task: RuntimeTaskSummary, keys: string[]): unknown {
  if (!task.gitInfo || typeof task.gitInfo !== 'object') return undefined
  return keys.map(key => task.gitInfo?.[key]).find(value => value !== undefined && value !== null)
}

function getRuntimeTaskBranch(task: RuntimeTaskSummary): string | null {
  const branch = getRuntimeTaskGitInfoValue(task, ['branch', 'branchName', 'branch_name'])
  return typeof branch === 'string' && branch.trim() ? branch.trim() : null
}

function hasRuntimeTaskBranchWarning(task: RuntimeTaskSummary): boolean {
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

function isRuntimeTaskWaiting(task: RuntimeTaskSummary): boolean {
  const status = task.status?.trim().toLowerCase() ?? ''
  return ['waiting', 'approval', 'input', 'attention', 'blocked'].some(value =>
    status.includes(value)
  )
}

function getProjectHoverSources(
  runtimeProjectWork: RuntimeProjectWork | undefined,
  finderWorkspacePath: string | null,
  openFinder: (path: string) => void,
  openFinderLabel: (path: string) => string
): ProjectHoverSource[] {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  const sources: ProjectHoverSource[] = []
  const seen = new Set<string>()
  const add = (source: ProjectHoverSource) => {
    const key = `${source.kind}\0${source.value}`
    if (!source.value || seen.has(key)) return
    seen.add(key)
    sources.push(source)
  }

  for (const workspace of workspaces) {
    if (workspace.workspaceSource === 'remote' || workspace.remoteHostId) {
      const host = workspace.remoteHostId || workspace.deviceName || workspace.deviceId
      add({ id: `host:${host}`, kind: 'host', value: host })
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

function isLocalProjectFinderDevice(device: DeviceInfo | undefined): device is DeviceInfo {
  if (!device) return false

  return (
    !isCloudDevice(device) &&
    !isRemoteDevice(device) &&
    isClaudeCodeDevice(device) &&
    canUseForProjectCreation(device)
  )
}

function getProjectFinderWorkspacePath(
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

function shouldShowProjectDeviceStatus(
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

function getRuntimeWorkspaceDeviceColor(workspace: RuntimeDeviceWorkspace): string {
  return getSidebarDeviceColor(getSidebarDeviceColorKey(workspace.deviceName, workspace.deviceId))
}

function getSidebarDeviceStatusLabel(
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

function getRuntimeNotificationKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}\0${address.workspacePath ?? ''}`
}

function getRuntimeTaskThreadId(task: RuntimeTaskSummary): string | null {
  const explicitThreadId = task.threadId?.trim()
  if (explicitThreadId) return explicitThreadId

  const runtimeHandleThreadId = [task.runtimeHandle?.threadId, task.runtimeHandle?.thread_id].find(
    value => typeof value === 'string' && value.trim()
  )
  if (typeof runtimeHandleThreadId === 'string') return runtimeHandleThreadId.trim()

  const taskId = task.taskId.trim()
  return task.runtime === 'codex' && !task.optimistic && taskId ? taskId : null
}

function isRuntimeTaskNotificationSubscribed(
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

function getImNotificationSessionLabel(
  settings: RuntimeIMNotificationSettingsResponse | null | undefined
): string | null {
  const session = settings?.global.session
  if (!session) return null
  const displayName = session.displayName || session.senderId
  return `${session.channelLabel} / ${displayName}`
}

function getGlobalImNotificationTitle(
  t: ReturnType<typeof useTranslation>['t'],
  settings: RuntimeIMNotificationSettingsResponse | null | undefined,
  cloudStatus?: 'disconnected' | 'connecting' | 'connected' | 'expired' | 'error'
): string {
  if (cloudStatus === 'disconnected') {
    return t(
      'workbench.global_im_notifications_requires_cloud_login',
      '登录云端后可开启离开电脑提醒'
    )
  }
  if (cloudStatus === 'expired' || cloudStatus === 'error') {
    return t(
      'workbench.global_im_notifications_requires_cloud_login',
      '登录云端后可开启离开电脑提醒'
    )
  }
  if (cloudStatus === 'connecting') {
    return t('workbench.cloud_connection_connecting', '正在连接云端')
  }

  const target = getImNotificationSessionLabel(settings)
  if (settings?.global.enabled) {
    return target
      ? `${t('workbench.away_im_reminder_on', '离开电脑提醒已开启')} · ${target}`
      : t('workbench.away_im_reminder_on', '离开电脑提醒已开启')
  }
  if (!target) {
    return t('workbench.away_im_reminder_needs_session', '需要选择 IM 会话')
  }
  return target
    ? `${t('workbench.away_im_reminder_enable', '开启离开电脑提醒')} · ${target}`
    : t('workbench.away_im_reminder_enable', '开启离开电脑提醒')
}

function formatSidebarTemplate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template
  )
}

function GlobalImNotificationBell({
  devices,
  imNotificationSettings,
  menuOpen,
  menuContainerRef,
  onMenuOpenChange,
  onToggleGlobalImNotification,
  onOpenGlobalImNotificationSettings,
  onOpenSettings,
  onAddCloudDevice,
}: {
  devices: DeviceInfo[]
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  menuOpen: boolean
  // Portal target covering the full-width account area. The bell trigger lives
  // inside a narrow 32px icon group, so the menu must anchor to this wider
  // relative container for `left-4 right-4` to resolve against the sidebar.
  menuContainerRef: RefObject<HTMLDivElement | null>
  onMenuOpenChange: (open: boolean) => void
  onToggleGlobalImNotification?: () => Promise<void> | void
  onOpenGlobalImNotificationSettings?: () => Promise<void> | void
  onOpenSettings: () => void
  onAddCloudDevice: () => void
}) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
  // Resolve the portal target from the ref into state. Reading the ref's
  // `.current` during render is disallowed, so we mirror it into state here.
  const [menuContainer, setMenuContainer] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    setMenuContainer(menuContainerRef.current)
  }, [menuContainerRef])
  const targetLabel = getImNotificationSessionLabel(imNotificationSettings)
  const enabled = Boolean(imNotificationSettings?.global.enabled)
  const connecting = cloud.status === 'connecting'
  const requiresCloudLogin = !cloud.isConnected
  const needsSession = cloud.isConnected && !targetLabel
  const notifying = enabled && cloud.isConnected && Boolean(targetLabel)
  const cloudConnectionError = cloud.status === 'error' || cloud.status === 'expired'
  const cloudConnectionErrorMessage = cloudConnectionError ? cloud.error : null
  const NotificationIcon = notifying ? Bell : BellOff
  const onlineCloudDeviceCount = useMemo(
    () =>
      devices.filter(
        device => (isCloudDevice(device) || isRemoteDevice(device)) && device.status === 'online'
      ).length,
    [devices]
  )
  const title = getGlobalImNotificationTitle(t, imNotificationSettings, cloud.status)
  const primaryActionLabel = requiresCloudLogin
    ? t('workbench.cloud_connection_login', '登录并连接')
    : enabled
      ? t('workbench.away_im_reminder_disable', '关闭提醒')
      : needsSession
        ? t('workbench.away_im_reminder_choose_session', '选择 IM 会话')
        : t('workbench.away_im_reminder_enable', '开启离开电脑提醒')

  const openCloudLogin = () => {
    onMenuOpenChange(false)
    setCloudDialogOpen(true)
  }

  const openSessionSettings = () => {
    onMenuOpenChange(false)
    const openSettings = onOpenGlobalImNotificationSettings ?? onToggleGlobalImNotification
    if (openSettings) {
      void openSettings()
      return
    }
    onOpenSettings()
  }

  const handlePrimaryAction = () => {
    if (connecting) return
    if (requiresCloudLogin) {
      openCloudLogin()
      return
    }
    if (!onToggleGlobalImNotification) {
      onMenuOpenChange(false)
      onOpenSettings()
      return
    }
    if (needsSession) {
      openSessionSettings()
      return
    }
    onMenuOpenChange(false)
    void onToggleGlobalImNotification()
  }

  return (
    <>
      <button
        type="button"
        data-testid="sidebar-global-im-notification-button"
        aria-pressed={notifying}
        disabled={connecting}
        onClick={() => onMenuOpenChange(!menuOpen)}
        className={cn(
          'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-50',
          notifying && 'text-primary hover:text-primary'
        )}
        title={title}
        aria-label={title}
      >
        <NotificationIcon
          data-testid={
            notifying
              ? 'sidebar-global-im-notification-on-icon'
              : 'sidebar-global-im-notification-muted-icon'
          }
          className={cn('h-4 w-4', notifying && 'fill-current')}
        />
        {needsSession && (
          <span
            data-testid="sidebar-global-im-notification-indicator"
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-background"
          />
        )}
      </button>

      {menuOpen &&
        menuContainer &&
        createPortal(
          <div
            data-testid="sidebar-global-im-notification-menu"
            className="absolute bottom-[68px] left-4 right-4 z-30 rounded-xl border border-border bg-background p-3 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary',
                  notifying && 'bg-primary/10 text-primary',
                  needsSession && 'bg-amber-400/15 text-amber-600'
                )}
              >
                <NotificationIcon className={cn('h-4 w-4', notifying && 'fill-current')} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold leading-5">
                  {notifying
                    ? t('workbench.away_im_reminder_on', '离开电脑提醒已开启')
                    : t('workbench.away_im_reminder_title', '离开电脑提醒')}
                </div>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  {t(
                    'workbench.away_im_reminder_description',
                    '所有任务进展会推送到 IM，不会改变任务的 IM 会话归属。'
                  )}
                </p>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-text-secondary">
                  {t('workbench.away_im_reminder_target', '投递到')}
                </span>
                <span className="min-w-0 truncate font-medium text-text-primary">
                  {targetLabel ?? t('workbench.away_im_reminder_no_target', '未选择 IM 会话')}
                </span>
              </div>
              {requiresCloudLogin && (
                <div className="mt-1 text-text-secondary">
                  {t(
                    'workbench.global_im_notifications_requires_cloud_login',
                    '登录云端后可开启离开电脑提醒'
                  )}
                </div>
              )}
              {cloudConnectionErrorMessage && (
                <div
                  data-testid="sidebar-global-im-notification-error"
                  className="mt-1 min-w-0 break-words text-red-500 [overflow-wrap:anywhere]"
                >
                  {cloudConnectionErrorMessage}
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              {cloud.isConnected && onOpenGlobalImNotificationSettings && (
                <button
                  type="button"
                  data-testid="sidebar-global-im-notification-settings-button"
                  onClick={openSessionSettings}
                  className="h-8 rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                >
                  {t('workbench.away_im_reminder_change_session', '更换会话')}
                </button>
              )}
              <button
                type="button"
                data-testid="sidebar-global-im-notification-primary-button"
                disabled={connecting}
                onClick={handlePrimaryAction}
                className={cn(
                  'h-8 shrink-0 whitespace-nowrap rounded-md px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-55',
                  enabled
                    ? 'bg-muted text-text-primary hover:bg-muted/80'
                    : 'bg-text-primary text-background hover:bg-text-primary/90'
                )}
              >
                {primaryActionLabel}
              </button>
            </div>
          </div>,
          menuContainer
        )}

      {cloudDialogOpen && (
        <CloudConnectionDialog
          open
          onlineCloudDeviceCount={onlineCloudDeviceCount}
          onClose={() => setCloudDialogOpen(false)}
          onOpenSettings={onOpenSettings}
          onAddDevice={onAddCloudDevice}
        />
      )}
    </>
  )
}

function SidebarAppUpdateButton({ onBeforeInstall }: { onBeforeInstall?: () => void }) {
  const { t } = useTranslation('common')
  const appUpdate = useOptionalAppUpdate()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [errorTooltipPosition, setErrorTooltipPosition] = useState<{
    left: number
    top: number
  } | null>(null)
  const availableUpdate = appUpdate?.availableUpdate ?? null
  const status = appUpdate?.status ?? 'idle'
  const downloadProgress = appUpdate?.downloadProgress ?? null
  const error = appUpdate?.error ?? null
  const busy = status === 'checking' || status === 'installing'
  const downloadPercent = downloadProgress
    ? calculateSidebarUpdateDownloadPercent(
        downloadProgress.downloadedBytes,
        downloadProgress.totalBytes
      )
    : null

  const showErrorTooltip = () => {
    if (!error || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setErrorTooltipPosition({
      left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - 268)),
      top: Math.min(Math.max(8, rect.top + rect.height / 2), window.innerHeight - 8),
    })
  }

  if (!appUpdate || !availableUpdate) return null

  const title = availableUpdate
    ? formatSidebarTemplate(
        t('workbench.app_update_install', {
          defaultValue: '更新到 {{version}}',
          version: availableUpdate.version,
        }),
        { version: availableUpdate.version }
      )
    : t('workbench.app_update_check', '检查更新')
  const downloadTitle =
    downloadPercent === null
      ? t('workbench.app_update_downloading', { defaultValue: '正在下载更新' })
      : formatSidebarTemplate(
          t('workbench.app_update_downloading_progress', {
            defaultValue: '正在下载更新 {{progress}}%',
            progress: downloadPercent,
          }),
          { progress: String(downloadPercent) }
        )

  return (
    <div
      className="group/update relative shrink-0"
      onPointerEnter={showErrorTooltip}
      onPointerLeave={() => setErrorTooltipPosition(null)}
      onFocus={showErrorTooltip}
      onBlur={() => setErrorTooltipPosition(null)}
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="sidebar-app-update-button"
        disabled={busy}
        onClick={() => {
          onBeforeInstall?.()
          if (availableUpdate) {
            void appUpdate.installUpdate()
            return
          }
          void appUpdate.checkNow()
        }}
        title={error ?? (status === 'installing' ? downloadTitle : title)}
        aria-label={error ?? (status === 'installing' ? downloadTitle : title)}
        className={cn(
          'group relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          error
            ? 'text-red-500 hover:bg-red-500/10'
            : 'text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]'
        )}
      >
        {status === 'installing' && downloadPercent !== null ? (
          <SidebarUpdateDownloadProgress progress={downloadPercent} />
        ) : busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="sidebar-update-download-icon h-4 w-4" />
        )}
        {availableUpdate && !busy && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-[rgb(var(--color-sidebar-hover))]" />
        )}
        {error && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[rgb(var(--color-sidebar-hover))]" />
        )}
      </button>
      {error && errorTooltipPosition
        ? createPortal(
            <div
              data-testid="sidebar-app-update-error"
              style={errorTooltipPosition}
              className="fixed z-system-popover w-[260px] -translate-y-1/2 rounded-lg border border-red-500/20 bg-popover px-3 py-2 text-xs font-medium leading-5 text-red-500 shadow-[0_12px_28px_rgba(0,0,0,0.18)] [overflow-wrap:anywhere]"
            >
              {error}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

function calculateSidebarUpdateDownloadPercent(
  downloadedBytes: number,
  totalBytes: number | null
): number | null {
  if (!totalBytes || totalBytes <= 0) return null
  return Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
}

function SidebarUpdateDownloadProgress({ progress }: { progress: number }) {
  return (
    <span
      data-testid="sidebar-app-update-download-progress"
      role="progressbar"
      aria-label={`Update download ${progress}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className="flex h-4 w-4 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(rgb(var(--color-primary)) ${progress}%, rgb(var(--color-sidebar-hover)) 0)`,
      }}
    >
      <span className="h-2 w-2 rounded-full bg-[rgb(var(--color-sidebar))]" />
    </span>
  )
}

function ProjectDeviceInlineStatus({
  deviceState,
  testId,
  className,
}: {
  deviceState: SidebarDeviceState
  testId: string
  className?: string
}) {
  const label = getDeviceRouteLabel(deviceState)
  const title = getDeviceRouteTitle(deviceState)
  const online = deviceState.status === 'online'

  return (
    <span
      data-testid={testId}
      title={title}
      aria-label={label}
      className={cn(
        'ml-auto flex min-w-0 shrink-0 items-center gap-2 text-sm leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]',
        className
      )}
    >
      <span className="max-w-[96px] truncate">{label}</span>
      <span
        data-testid={`${testId}-dot`}
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          !online && 'bg-[rgb(var(--color-sidebar-text-muted))] opacity-55'
        )}
        style={online ? { backgroundColor: '#1FD660' } : undefined}
      />
    </span>
  )
}

function getDeviceUnavailableActionTitle(
  t: ReturnType<typeof useTranslation>['t'],
  deviceState: SidebarDeviceState
) {
  const status = getSidebarDeviceStatusLabel(t, deviceState.status)
  return formatSidebarTemplate(
    t('workbench.project_chat_device_unavailable', '设备{{status}}，无法新建项目对话：{{device}}'),
    { status, device: getSidebarDeviceName(deviceState) }
  )
}

function RuntimeTaskRow({
  workspace,
  task,
  projectName,
  selected,
  unread,
  marked: controlledMarked,
  indentClassName = 'pl-12',
  imNotificationSettings,
  showDeviceMarker,
  stateDeviceId,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onSetRuntimeTaskPinned,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onToggleRuntimeTaskNotification,
}: {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  projectName?: string | null
  selected: boolean
  unread?: boolean
  marked?: boolean
  indentClassName?: string
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  stateDeviceId?: string | null
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onRenameRuntimeTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const [optimisticMarked, setOptimisticMarked] = useState<{
    base: boolean
    value: boolean
  } | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archivePending, setArchivePending] = useState(false)
  const [archiveNoticeOpen, setArchiveNoticeOpen] = useState(false)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [taskMenuPosition, setTaskMenuPosition] = useState<ProjectCreateMenuPosition | null>(null)
  const archiveDelayRef = useRef<number | null>(null)
  const worktreeTask = isRuntimeWorktreeTask(task)
  const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
  const projectLabel = projectName?.trim() || t('workbench.task')
  const repositoryLabel = getRuntimeTaskRepositoryLabel(workspace, task)
  const branchLabel = getRuntimeTaskBranch(task)
  const taskWorkspacePath = task.workspacePath || workspace.workspacePath
  const hostLabel =
    workspace.remoteHostId ||
    (workspace.workspaceSource === 'remote' ? workspace.deviceName || workspace.deviceId : null)
  const deviceColor = getRuntimeWorkspaceDeviceColor(workspace)
  const disabled = !workspace.available || !onOpenRuntimeTask
  const archiveDisabled =
    !workspace.available || !onArchiveRuntimeTask || archiving || archivePending
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  const threadId = getRuntimeTaskThreadId(task)
  const notificationsSubscribed = isRuntimeTaskNotificationSubscribed(
    imNotificationSettings,
    taskAddress
  )
  const persistedMarked = controlledMarked ?? task.pinned ?? false
  const marked =
    optimisticMarked?.base === persistedMarked ? optimisticMarked.value : persistedMarked
  const notificationsDisabled = !workspace.available || !onToggleRuntimeTaskNotification
  const handleOpen = () => {
    if (disabled) return
    onMarkRuntimeTaskRead?.(taskAddress)
    void onOpenRuntimeTask?.(taskAddress)
  }
  const toggleTaskPinned = async () => {
    if (!workspace.available || !threadId || !onSetRuntimeTaskPinned) return
    const nextMarked = !marked
    setOptimisticMarked({ base: persistedMarked, value: nextMarked })
    try {
      await onSetRuntimeTaskPinned({
        deviceId: stateDeviceId || workspace.deviceId,
        threadId,
        pinned: nextMarked,
      })
    } catch {
      setOptimisticMarked(null)
    }
  }
  const handleToggleMark = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    void toggleTaskPinned()
  }
  useEffect(() => {
    return () => {
      if (archiveDelayRef.current !== null) {
        window.clearTimeout(archiveDelayRef.current)
      }
    }
  }, [])
  const runArchive = async (options?: ArchiveRuntimeTaskOptions) => {
    setArchiving(true)
    try {
      const result = await Promise.resolve(
        options ? onArchiveRuntimeTask?.(taskAddress, options) : onArchiveRuntimeTask?.(taskAddress)
      )
      if (result?.status === 'dirty_worktree') {
        setForceArchiveConfirmOpen(true)
      }
    } finally {
      setArchiving(false)
    }
  }
  const scheduleArchive = () => {
    if (archiveDisabled) return
    setArchivePending(true)
    setArchiveNoticeOpen(true)
    archiveDelayRef.current = window.setTimeout(() => {
      archiveDelayRef.current = null
      setArchivePending(false)
      setArchiveNoticeOpen(false)
      void runArchive()
    }, RUNTIME_ARCHIVE_UNDO_DELAY_MS)
  }
  const handleArchive = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    scheduleArchive()
  }
  const handleUndoArchive = () => {
    if (archiveDelayRef.current !== null) {
      window.clearTimeout(archiveDelayRef.current)
      archiveDelayRef.current = null
    }
    setArchivePending(false)
    setArchiveNoticeOpen(false)
  }
  const handleDismissArchiveNotice = () => {
    setArchiveNoticeOpen(false)
  }
  const handleCloseForceArchiveConfirm = () => {
    if (!archiving) {
      setForceArchiveConfirmOpen(false)
    }
  }
  const handleConfirmForceArchive = async () => {
    await runArchive({ force: true })
    setForceArchiveConfirmOpen(false)
  }
  const handleToggleNotification = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    if (notificationsDisabled) return
    void onToggleRuntimeTaskNotification?.(taskAddress, notificationsSubscribed)
  }
  const notificationActionLabel = notificationsSubscribed
    ? t('workbench.unsubscribe_runtime_task_notifications', '取消任务通知')
    : t('workbench.subscribe_runtime_task_notifications', '订阅任务通知')
  const NotificationIcon = notificationsSubscribed ? Bell : BellOff
  const renderNotificationButton = (testId: string, iconTestId: string) => (
    <button
      type="button"
      data-testid={testId}
      disabled={notificationsDisabled}
      aria-pressed={notificationsSubscribed}
      onClick={handleToggleNotification}
      className={cn(
        'flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45',
        notificationsSubscribed && 'text-primary'
      )}
      title={notificationActionLabel}
      aria-label={notificationActionLabel}
    >
      <NotificationIcon
        data-testid={iconTestId}
        className={cn('h-[15px] w-[15px]', notificationsSubscribed && 'fill-current')}
      />
    </button>
  )

  return (
    <>
      <SidebarHoverCard
        testId={`runtime-local-task-hover-card-${task.taskId}`}
        interactive
        content={
          <TaskSidebarHoverCardContent
            taskId={task.taskId}
            title={task.title}
            projectLabel={projectLabel}
            repositoryLabel={repositoryLabel}
            branchLabel={branchLabel}
            workspacePath={taskWorkspacePath ? shortenSidebarHomePath(taskWorkspacePath) : null}
            hostLabel={hostLabel}
            updatedLabel={task.updatedAt ? formatRelativeSidebarTime(task.updatedAt) : null}
            branchWarning={hasRuntimeTaskBranchWarning(task)}
          />
        }
      >
        <div
          data-testid={`runtime-local-task-row-${task.taskId}`}
          data-marked={marked ? 'true' : undefined}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={handleOpen}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            setTaskMenuPosition({ left: event.clientX, top: event.clientY })
          }}
          onDoubleClick={event => {
            event.stopPropagation()
            if (!disabled && onRenameRuntimeTask) {
              setRenameOpen(true)
            }
          }}
          onKeyDown={event => handleSidebarRowKeyDown(event, handleOpen)}
          className={cn(
            'group/task relative flex h-[30px] min-w-0 items-center rounded-[10px] pr-2 text-base leading-5',
            indentClassName,
            disabled ? 'cursor-not-allowed opacity-55' : 'cursor-default',
            selected
              ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
              : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
            (archivePending || archiving) && 'hidden'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          <span
            data-testid={`runtime-local-task-trailing-${task.taskId}`}
            className="relative ml-1 flex h-[30px] min-w-[30px] shrink-0 items-center justify-end transition-[width] group-hover/task:w-[68px]"
          >
            <span
              data-testid={`runtime-local-task-time-${task.taskId}`}
              className={SIDEBAR_ROW_METADATA_CLASS}
            >
              {worktreeTask && (
                <GitCompareArrows
                  data-testid={`runtime-local-task-worktree-icon-${task.taskId}`}
                  className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]"
                  aria-label="Worktree"
                />
              )}
              {experimentalFeaturesEnabled &&
                notificationsSubscribed &&
                renderNotificationButton(
                  `runtime-local-task-notify-${task.taskId}`,
                  `runtime-local-task-notify-icon-${task.taskId}`
                )}
              <span className="flex h-[30px] w-[30px] items-center justify-center">
                {task.running ? (
                  <span
                    data-testid={`runtime-local-task-running-${task.taskId}`}
                    role="status"
                    title={t('workbench.runtime_task_running')}
                    aria-label={t('workbench.runtime_task_running')}
                    className="flex h-[30px] w-[30px] items-center justify-center"
                  >
                    <Loader2 className={SIDEBAR_RUNNING_SPINNER_CLASS} aria-hidden="true" />
                  </span>
                ) : unread ? (
                  <span
                    data-testid={`runtime-local-task-unread-dot-${task.taskId}`}
                    aria-label={t('workbench.runtime_task_unread', '未读')}
                    title={t('workbench.runtime_task_unread', '未读')}
                    className="h-1.5 w-1.5 rounded-full bg-primary"
                  />
                ) : (
                  formatRelativeSidebarTime(getRuntimeTaskTime(task))
                )}
              </span>
              {showDeviceMarker && (
                <span
                  data-testid={`runtime-local-task-device-marker-${task.taskId}`}
                  title={workspaceTitle}
                  aria-label={workspaceTitle}
                  className="h-3.5 w-0.5 shrink-0 rounded-full"
                  style={{ backgroundColor: deviceColor }}
                />
              )}
            </span>
            <span
              data-testid={`runtime-local-task-hover-actions-${task.taskId}`}
              className="pointer-events-none absolute right-0 top-1/2 z-[70] flex w-[72px] -translate-y-1/2 items-center justify-end gap-1 opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
            >
              {experimentalFeaturesEnabled &&
                renderNotificationButton(
                  notificationsSubscribed
                    ? `runtime-local-task-notify-hover-${task.taskId}`
                    : `runtime-local-task-notify-${task.taskId}`,
                  notificationsSubscribed
                    ? `runtime-local-task-notify-hover-icon-${task.taskId}`
                    : `runtime-local-task-notify-icon-${task.taskId}`
                )}
              <button
                type="button"
                data-testid={`runtime-local-task-mark-${task.taskId}`}
                onClick={handleToggleMark}
                disabled={!workspace.available || !threadId || !onSetRuntimeTaskPinned}
                className={cn(
                  'flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))]',
                  marked && 'text-[rgb(var(--color-sidebar-marked-accent))]'
                )}
                title={
                  marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task')
                }
                aria-label={
                  marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task')
                }
              >
                <Pin
                  data-testid={`runtime-local-task-pin-icon-${task.taskId}`}
                  className={cn('h-[15px] w-[15px]', marked && 'fill-current')}
                />
              </button>
              <button
                type="button"
                data-testid={`runtime-local-task-archive-${task.taskId}`}
                disabled={archiveDisabled}
                onClick={handleArchive}
                className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                title={t('workbench.archive_runtime_task', '归档')}
                aria-label={t('workbench.archive_runtime_task', '归档')}
              >
                {archiving ? (
                  <RotateCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Archive
                    data-testid={`runtime-local-task-archive-icon-${task.taskId}`}
                    className="h-[15px] w-[15px]"
                  />
                )}
              </button>
            </span>
          </span>
        </div>
      </SidebarHoverCard>
      <ActionMenu
        ariaLabel={t('workbench.task_actions')}
        testId={`runtime-local-task-menu-${task.taskId}`}
        contextMenuPosition={taskMenuPosition}
        onContextMenuClose={() => setTaskMenuPosition(null)}
        triggerClassName="hidden"
        items={[
          {
            label: marked ? t('workbench.unmark_runtime_task') : t('workbench.mark_runtime_task'),
            icon: Pin,
            testId: `runtime-local-task-menu-pin-${task.taskId}`,
            disabled: !workspace.available || !threadId || !onSetRuntimeTaskPinned,
            onSelect: toggleTaskPinned,
          },
          {
            label: t('workbench.rename_chat', '重命名任务'),
            icon: Edit3,
            testId: `runtime-local-task-menu-rename-${task.taskId}`,
            disabled: !workspace.available || !onRenameRuntimeTask,
            onSelect: () => setRenameOpen(true),
          },
          ...(experimentalFeaturesEnabled
            ? [
                {
                  label: notificationActionLabel,
                  icon: NotificationIcon,
                  testId: `runtime-local-task-menu-notify-${task.taskId}`,
                  disabled: notificationsDisabled,
                  onSelect: () =>
                    onToggleRuntimeTaskNotification?.(taskAddress, notificationsSubscribed),
                },
              ]
            : []),
          {
            label: t('workbench.archive_runtime_task', '归档'),
            icon: Archive,
            testId: `runtime-local-task-menu-archive-${task.taskId}`,
            disabled: archiveDisabled,
            onSelect: scheduleArchive,
          },
        ]}
      />
      <TextInputDialog
        open={renameOpen}
        title={t('workbench.rename_chat', '重命名会话')}
        label={t('workbench.chat_name', '会话名称')}
        description={t('workbench.rename_chat_description', '保持简短且易于识别')}
        initialValue={task.title}
        confirmLabel={t('workbench.save', '保存')}
        cancelLabel={t('workbench.cancel', '取消')}
        inputTestId={`rename-runtime-local-task-input-${task.taskId}`}
        confirmTestId={`confirm-rename-runtime-local-task-${task.taskId}`}
        onClose={() => setRenameOpen(false)}
        onSubmit={title => {
          if (workspace.available) onRenameRuntimeTask?.(taskAddress, title)
        }}
      />
      {archiveNoticeOpen &&
        createPortal(
          <div
            data-testid={`runtime-local-task-archive-toast-${task.taskId}`}
            role="status"
            aria-live="polite"
            className="fixed left-1/2 top-5 z-[200] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-text-primary shadow-lg"
          >
            <button
              type="button"
              data-testid={`runtime-local-task-archive-undo-${task.taskId}`}
              onClick={handleUndoArchive}
              className="font-medium text-primary hover:underline"
            >
              {t('workbench.archive_runtime_task_undo', '撤销')}
            </button>
            <span>{t('workbench.archive_runtime_task_pending', '，稍后将归档')}</span>
            <button
              type="button"
              data-testid={`runtime-local-task-archive-toast-close-${task.taskId}`}
              onClick={handleDismissArchiveNotice}
              className="ml-2 flex h-5 w-5 items-center justify-center rounded-full text-text-muted hover:bg-muted hover:text-text-primary"
              title={t('workbench.archive_runtime_task_notice_close', '关闭归档提示')}
              aria-label={t('workbench.archive_runtime_task_notice_close', '关闭归档提示')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>,
          document.body
        )}
      <ArchiveConversationsConfirmDialog
        open={forceArchiveConfirmOpen}
        title={t('workbench.archive_runtime_task_dirty_worktree_title')}
        description={t('workbench.archive_runtime_task_dirty_worktree_force_desc')}
        confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
        cancelLabel={t('workbench.cancel')}
        submitting={archiving}
        testId={`runtime-local-task-force-archive-dialog-${task.taskId}`}
        onClose={handleCloseForceArchiveConfirm}
        onConfirm={handleConfirmForceArchive}
      />
    </>
  )
}

function ProjectItem({
  project,
  expanded,
  onToggleProject,
  devices,
  runtimeProjectWork,
  currentRuntimeTask,
  unreadTaskKeys,
  imNotificationSettings,
  showDeviceMarker,
  sidebarStateDeviceId,
  onStartNewProjectChat,
  onRemoveProject,
  onCreatePermanentWorktree,
  onSetRuntimeProjectPinned,
  onSetRuntimeProjectAppearance,
  onReorderRuntimeProjectTasks,
  onSetRuntimeTaskPinned,
  onRenameProject,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onArchiveProjectConversations,
  onToggleRuntimeTaskNotification,
}: {
  project: ProjectWithTasks
  expanded: boolean
  onToggleProject: (projectId: number) => void
  devices: DeviceInfo[]
  runtimeProjectWork?: RuntimeProjectWork
  currentRuntimeTask?: RuntimeTaskAddress | null
  unreadTaskKeys: ReadonlySet<string>
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  sidebarStateDeviceId?: string | null
  onStartNewProjectChat: (projectId: number) => void
  onRemoveProject: (projectId: number) => Promise<void>
  onCreatePermanentWorktree?: (data: {
    deviceId: string
    sourcePath: string
    name: string
  }) => Promise<void>
  onReorderRuntimeProjects?: (data: RuntimeProjectReorderRequest) => Promise<void>
  onSetRuntimeProjectPinned?: (data: RuntimeProjectPinRequest) => Promise<void>
  onSetRuntimeProjectAppearance?: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  onReorderRuntimeProjectTasks?: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onRenameProject: (project: ProjectWithTasks) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onRenameRuntimeTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeTask?: (
    address: RuntimeTaskAddress,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeTaskResult | void> | ArchiveRuntimeTaskResult | void
  onArchiveProjectConversations?: (
    runtimeProjectKey: string,
    options?: ArchiveRuntimeTaskOptions
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const runtimeWorkspaces = runtimeProjectWork?.deviceWorkspaces
  const allRuntimeTaskItems = useMemo(
    () => getRuntimeSidebarTaskItems(runtimeWorkspaces ?? []),
    [runtimeWorkspaces]
  )
  const runtimeTaskItems = useMemo(
    () => allRuntimeTaskItems.filter(({ task }) => !task.pinned),
    [allRuntimeTaskItems]
  )
  const [runtimeTaskVisibleLimit, setRuntimeTaskVisibleLimit] = useState(
    RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
  )
  const [projectArchiving, setProjectArchiving] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [createPermanentWorktreeOpen, setCreatePermanentWorktreeOpen] = useState(false)
  const [removingProject, setRemovingProject] = useState(false)
  const [optimisticProjectPinned, setOptimisticProjectPinned] = useState<{
    base: boolean
    value: boolean
  } | null>(null)
  const [projectMenuPosition, setProjectMenuPosition] = useState<ProjectCreateMenuPosition | null>(
    null
  )
  const prioritizedRuntimeTaskItems = runtimeTaskItems
  const visibleRuntimeTaskItems = useMemo(
    () => getVisibleRuntimeSidebarTaskItems(prioritizedRuntimeTaskItems, runtimeTaskVisibleLimit),
    [prioritizedRuntimeTaskItems, runtimeTaskVisibleLimit]
  )
  const hasHiddenRuntimeTasks = hasHiddenRuntimeSidebarTaskItems(
    prioritizedRuntimeTaskItems,
    runtimeTaskVisibleLimit
  )
  const canCollapseRuntimeTasks = hasExpandedRuntimeSidebarTaskItems(
    prioritizedRuntimeTaskItems,
    runtimeTaskVisibleLimit
  )
  useEffect(() => {
    const details = {
      projectId: project.id,
      currentTaskId: currentRuntimeTask?.taskId ?? null,
      visibleLimit: runtimeTaskVisibleLimit,
      allTaskIds: prioritizedRuntimeTaskItems.map(item => item.task.taskId),
      visibleTaskIds: visibleRuntimeTaskItems.map(item => item.task.taskId),
      hiddenTaskIds: prioritizedRuntimeTaskItems
        .slice(visibleRuntimeTaskItems.length)
        .map(item => item.task.taskId),
    }
    debugRuntimeSidebarState('project-visible-items', details)

    const currentTaskId = currentRuntimeTask?.taskId
    if (
      currentTaskId &&
      prioritizedRuntimeTaskItems.some(item => item.task.taskId === currentTaskId) &&
      !visibleRuntimeTaskItems.some(item => item.task.taskId === currentTaskId)
    ) {
      warnRuntimeSidebarMismatch(details)
    }
  }, [
    currentRuntimeTask?.taskId,
    prioritizedRuntimeTaskItems,
    project.id,
    runtimeTaskVisibleLimit,
    visibleRuntimeTaskItems,
  ])
  const projectDeviceState =
    getRuntimeProjectDeviceState(runtimeProjectWork, devices) ??
    getSidebarDeviceState(getProjectDeviceId(project), devices)
  const showProjectDeviceStatus = shouldShowProjectDeviceStatus(
    projectDeviceState,
    devices,
    isRuntimeRemoteProject(runtimeProjectWork)
  )
  const canStartProjectChat = isSidebarDeviceOnline(projectDeviceState)
  const canArchiveProjectConversations =
    Boolean(runtimeProjectWork?.project.key) &&
    allRuntimeTaskItems.length > 0 &&
    Boolean(onArchiveProjectConversations) &&
    !projectArchiving
  const finderWorkspacePath = getProjectFinderWorkspacePath(project, runtimeProjectWork, devices)
  const permanentWorktreeSource = runtimeWorkspaces?.find(
    workspace => workspace.deviceId.trim() && workspace.workspacePath.trim()
  )
  const newProjectChatTitle =
    projectDeviceState && !canStartProjectChat
      ? getDeviceUnavailableActionTitle(t, projectDeviceState)
      : t('workbench.new_project_chat', '新建项目对话')
  const archiveConversationCount = allRuntimeTaskItems.length
  const archiveProjectName = runtimeProjectWork?.project.name ?? project.name
  const persistedProjectPinned = runtimeProjectWork?.project.pinned ?? false
  const projectPinned =
    optimisticProjectPinned?.base === persistedProjectPinned
      ? optimisticProjectPinned.value
      : persistedProjectPinned
  const projectStateDeviceId =
    sidebarStateDeviceId ??
    runtimeProjectWork?.project.stateDeviceId ??
    runtimeWorkspaces?.[0]?.deviceId ??
    null
  const projectSidebarStateKey = runtimeProjectWork
    ? getRuntimeProjectSidebarStateKey(runtimeProjectWork.project)
    : null
  const projectAppearance = runtimeProjectWork?.project.appearance
  const projectMarker = projectAppearance?.marker
  const projectAppearanceColor = projectAppearance?.color
    ? PROJECT_APPEARANCE_COLOR_VALUES[projectAppearance.color]
    : undefined
  const projectHoverSources = getProjectHoverSources(
    runtimeProjectWork,
    finderWorkspacePath,
    path => {
      void openLocalWorkspace({ opener: 'finder', path })
    },
    path =>
      formatSidebarTemplate(t('workbench.open_project_source'), {
        source: shortenSidebarHomePath(path),
      })
  )
  const projectActiveTaskCount = allRuntimeTaskItems.filter(({ task }) => task.running).length
  const projectWaitingTaskCount = allRuntimeTaskItems.filter(({ task }) =>
    isRuntimeTaskWaiting(task)
  ).length
  const projectUnreadTaskCount = allRuntimeTaskItems.filter(({ workspace, task }) =>
    unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))
  ).length
  const toggleProjectPinned = async () => {
    const projectKey = projectSidebarStateKey
    if (!projectKey || !projectStateDeviceId || !onSetRuntimeProjectPinned) return
    const nextPinned = !projectPinned
    setOptimisticProjectPinned({ base: persistedProjectPinned, value: nextPinned })
    try {
      await onSetRuntimeProjectPinned({
        deviceId: projectStateDeviceId,
        projectKey,
        pinned: nextPinned,
      })
    } catch {
      setOptimisticProjectPinned(null)
    }
  }
  const cycleProjectAppearance = async () => {
    const projectKey = projectSidebarStateKey
    if (!projectKey || !projectStateDeviceId || !onSetRuntimeProjectAppearance) return
    const currentIndex = PROJECT_APPEARANCE_COLORS.indexOf(
      projectAppearance?.color as (typeof PROJECT_APPEARANCE_COLORS)[number]
    )
    const color = PROJECT_APPEARANCE_COLORS[(currentIndex + 1) % PROJECT_APPEARANCE_COLORS.length]
    await onSetRuntimeProjectAppearance({
      deviceId: projectStateDeviceId,
      projectKey,
      appearance: { ...projectAppearance, color },
    })
  }
  const closeArchiveConfirm = () => {
    if (!projectArchiving) {
      setArchiveConfirmOpen(false)
    }
  }
  const runArchiveProjectConversations = async (options?: ArchiveRuntimeTaskOptions) => {
    const runtimeProjectKey = runtimeProjectWork?.project.key
    if (!runtimeProjectKey || !onArchiveProjectConversations) return
    setProjectArchiving(true)
    try {
      const result = await onArchiveProjectConversations(runtimeProjectKey, options)
      if (result?.status === 'dirty_worktree') {
        setArchiveConfirmOpen(false)
        setForceArchiveConfirmOpen(true)
        return
      }
      setArchiveConfirmOpen(false)
      setForceArchiveConfirmOpen(false)
    } finally {
      setProjectArchiving(false)
    }
  }
  const confirmArchiveProjectConversations = () => runArchiveProjectConversations()
  const closeForceArchiveConfirm = () => {
    if (!projectArchiving) {
      setForceArchiveConfirmOpen(false)
    }
  }
  const confirmForceArchiveProjectConversations = () =>
    runArchiveProjectConversations({ force: true })
  const closeRemoveConfirm = () => {
    if (!removingProject) {
      setRemoveConfirmOpen(false)
    }
  }
  const confirmRemoveProject = async () => {
    setRemovingProject(true)
    try {
      await onRemoveProject(project.id)
      setRemoveConfirmOpen(false)
    } catch (error) {
      console.error('[Wework project removal] failed', error)
    } finally {
      setRemovingProject(false)
    }
  }

  return (
    <div data-testid="project-item" className="space-y-0.5">
      <SidebarHoverCard
        testId={`project-hover-card-${project.id}`}
        interactive
        cardClassName="w-[320px]"
        content={
          <ProjectSidebarHoverCardContent
            project={project}
            remote={isRuntimeRemoteProject(runtimeProjectWork)}
            marker={
              projectMarker?.kind === 'emoji' && 'emoji' in projectMarker ? (
                <span className="text-sm">{String(projectMarker.emoji)}</span>
              ) : undefined
            }
            markerColor={projectAppearanceColor}
            taskCount={allRuntimeTaskItems.length}
            activeCount={projectActiveTaskCount}
            waitingCount={projectWaitingTaskCount}
            unreadCount={projectUnreadTaskCount}
            pinned={projectPinned}
            canPin={Boolean(
              runtimeProjectWork?.project.key && projectStateDeviceId && onSetRuntimeProjectPinned
            )}
            sources={projectHoverSources}
            onTogglePin={() => void toggleProjectPinned()}
            onRename={() => onRenameProject(project)}
          />
        }
      >
        <div
          data-testid={`project-row-${project.id}`}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            setProjectMenuPosition({ left: event.clientX, top: event.clientY })
          }}
          className="group/project relative flex h-[30px] min-w-0 items-center gap-1 rounded-[10px] pl-2.5 pr-1 text-base leading-5 text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
        >
          <button
            type="button"
            data-testid="project-item-button"
            onClick={() => {
              onToggleProject(project.id)
            }}
            aria-expanded={expanded}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 text-left',
              showProjectDeviceStatus ? 'pr-[132px]' : 'pr-[58px]'
            )}
          >
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center"
              style={projectAppearanceColor ? { color: projectAppearanceColor } : undefined}
            >
              {projectMarker?.kind === 'emoji' && 'emoji' in projectMarker ? (
                <span data-testid={`project-appearance-emoji-${project.id}`} className="text-sm">
                  {String(projectMarker.emoji)}
                </span>
              ) : (
                <ProjectFolderIcon
                  project={project}
                  remote={isRuntimeRemoteProject(runtimeProjectWork)}
                  className="h-3.5 w-3.5 shrink-0"
                />
              )}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span data-testid={`project-title-${project.id}`} className="min-w-0 truncate">
                {project.name}
              </span>
              <ChevronRight
                data-testid={`project-collapsed-hover-indicator-${project.id}`}
                className={cn(
                  'hidden h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-primary))] opacity-0 transition-opacity',
                  !expanded &&
                    'group-hover/project:block group-hover/project:opacity-100 group-focus-within/project:block group-focus-within/project:opacity-100'
                )}
              />
              <ChevronDown
                data-testid={`project-expanded-hover-indicator-${project.id}`}
                className={cn(
                  'hidden h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-primary))] opacity-0 transition-opacity',
                  expanded &&
                    'group-hover/project:block group-hover/project:opacity-100 group-focus-within/project:block group-focus-within/project:opacity-100'
                )}
              />
            </span>
          </button>
          {showProjectDeviceStatus && (
            <ProjectDeviceInlineStatus
              deviceState={projectDeviceState}
              testId={`project-device-status-${project.id}`}
              className="pointer-events-none absolute right-2 top-1/2 max-w-[124px] -translate-y-1/2 justify-end text-right group-hover/project:invisible group-focus-within/project:invisible"
            />
          )}
          <div className="pointer-events-none absolute right-1 top-1/2 z-[70] flex w-[58px] shrink-0 -translate-y-1/2 items-center justify-end opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
            <ActionMenu
              ariaLabel={t('workbench.project_actions', '项目操作')}
              testId={`project-menu-${project.id}`}
              contextMenuPosition={projectMenuPosition}
              onContextMenuClose={() => setProjectMenuPosition(null)}
              items={[
                {
                  label: projectPinned ? t('workbench.unpin_project') : t('workbench.pin_project'),
                  icon: Pin,
                  testId: `pin-project-${project.id}`,
                  disabled:
                    !runtimeProjectWork?.project.key ||
                    !projectStateDeviceId ||
                    !onSetRuntimeProjectPinned,
                  onSelect: toggleProjectPinned,
                },
                {
                  label: t('workbench.rename_project', '重命名项目'),
                  icon: Edit3,
                  testId: `rename-project-${project.id}`,
                  onSelect: () => onRenameProject(project),
                },
                {
                  label: t('workbench.change_project_appearance'),
                  icon: Sparkles,
                  testId: `change-project-appearance-${project.id}`,
                  disabled:
                    !runtimeProjectWork?.project.key ||
                    !projectStateDeviceId ||
                    !onSetRuntimeProjectAppearance,
                  onSelect: cycleProjectAppearance,
                },
                ...(finderWorkspacePath
                  ? [
                      {
                        label: t('workbench.show_in_finder', '在 Finder 中显示'),
                        icon: FolderOpen,
                        testId: `show-project-in-finder-${project.id}`,
                        onSelect: () =>
                          openLocalWorkspace({
                            opener: 'finder',
                            path: finderWorkspacePath,
                          }),
                      },
                    ]
                  : []),
                {
                  label: t('workbench.create_permanent_worktree'),
                  icon: GitCompareArrows,
                  testId: `create-permanent-worktree-${project.id}`,
                  disabled: !permanentWorktreeSource || !onCreatePermanentWorktree,
                  onSelect: () => setCreatePermanentWorktreeOpen(true),
                },
                {
                  label: projectArchiving
                    ? t('workbench.archiving_conversations', '归档中...')
                    : t('workbench.archive_project_conversations', '归档对话'),
                  icon: Archive,
                  testId: `archive-project-conversations-${project.id}`,
                  disabled: !canArchiveProjectConversations,
                  onSelect: () => setArchiveConfirmOpen(true),
                },
                {
                  label: t('workbench.remove_project', '移除'),
                  icon: X,
                  testId: `remove-project-${project.id}`,
                  danger: true,
                  onSelect: () => setRemoveConfirmOpen(true),
                },
              ]}
              triggerClassName="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
            />
            <button
              type="button"
              data-testid="project-new-conversation-button"
              disabled={!canStartProjectChat}
              onClick={event => {
                event.stopPropagation()
                if (!canStartProjectChat) return
                onStartNewProjectChat(project.id)
              }}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-sidebar-text-secondary))]"
              title={newProjectChatTitle}
              aria-label={newProjectChatTitle}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          </div>
        </div>
      </SidebarHoverCard>
      <TextInputDialog
        open={createPermanentWorktreeOpen}
        title={t('workbench.create_permanent_worktree_title')}
        description={t('workbench.create_permanent_worktree_description')}
        label={t('workbench.project_name')}
        initialValue={`${project.name}_2`}
        confirmLabel={t('workbench.create')}
        cancelLabel={t('workbench.cancel')}
        inputTestId={`permanent-worktree-name-${project.id}`}
        confirmTestId={`confirm-create-permanent-worktree-${project.id}`}
        onClose={() => setCreatePermanentWorktreeOpen(false)}
        onSubmit={async name => {
          if (!permanentWorktreeSource || !onCreatePermanentWorktree) return
          await onCreatePermanentWorktree({
            deviceId: permanentWorktreeSource.deviceId,
            sourcePath: permanentWorktreeSource.workspacePath,
            name,
          })
        }}
      />
      <div
        data-testid={`project-local-tasks-panel-${project.id}`}
        aria-hidden={!expanded}
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows,opacity] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-0.5">
            {runtimeTaskItems.length === 0 ? (
              <div
                data-testid={`project-local-tasks-empty-${project.id}`}
                className="ml-9 rounded-md px-2 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
              >
                {t('workbench.no_chats', '暂无会话')}
              </div>
            ) : (
              <>
                <SidebarSortableList
                  testId={`project-runtime-task-sortable-${project.id}`}
                  className="space-y-0.5"
                  items={visibleRuntimeTaskItems}
                  getId={({ workspace, task }) =>
                    `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
                  }
                  getLabel={({ task }) => task.title}
                  canDrag={({ task }) =>
                    Boolean(
                      getRuntimeTaskThreadId(task) &&
                      runtimeProjectWork?.project.key &&
                      onReorderRuntimeProjectTasks
                    )
                  }
                  onMove={async (moved, before) => {
                    const projectKey = runtimeProjectWork?.project.key
                    const deviceId =
                      runtimeProjectWork?.project.stateDeviceId || moved.workspace.deviceId
                    const movedThreadId = getRuntimeTaskThreadId(moved.task)
                    if (!projectKey || !movedThreadId || !onReorderRuntimeProjectTasks) {
                      throw new Error('Runtime task ordering is unavailable')
                    }
                    const firstHiddenTask = prioritizedRuntimeTaskItems.at(
                      visibleRuntimeTaskItems.length
                    )?.task
                    const beforeThreadId =
                      (before ? getRuntimeTaskThreadId(before.task) : null) ||
                      (firstHiddenTask ? getRuntimeTaskThreadId(firstHiddenTask) : null)
                    await onReorderRuntimeProjectTasks({
                      deviceId,
                      projectKey,
                      threadId: movedThreadId,
                      beforeThreadId,
                      insertAtEnd: beforeThreadId === null,
                    })
                  }}
                  renderItem={({ workspace, task }) => (
                    <RuntimeTaskRow
                      workspace={workspace}
                      task={task}
                      projectName={runtimeProjectWork?.project.name ?? project.name}
                      selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                      unread={unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))}
                      marked={task.pinned}
                      indentClassName="pl-9"
                      imNotificationSettings={imNotificationSettings}
                      showDeviceMarker={showDeviceMarker}
                      onOpenRuntimeTask={onOpenRuntimeTask}
                      onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                      stateDeviceId={runtimeProjectWork?.project.stateDeviceId}
                      onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
                      onRenameRuntimeTask={onRenameRuntimeTask}
                      onArchiveRuntimeTask={onArchiveRuntimeTask}
                      onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                    />
                  )}
                />
                {(hasHiddenRuntimeTasks || canCollapseRuntimeTasks) && (
                  <div className="ml-9 flex h-8 items-center gap-2">
                    {hasHiddenRuntimeTasks ? (
                      <button
                        type="button"
                        data-testid={`project-runtime-tasks-expand-${project.id}`}
                        onClick={() =>
                          setRuntimeTaskVisibleLimit(currentLimit =>
                            getNextRuntimeSidebarTaskVisibleLimit(
                              currentLimit,
                              prioritizedRuntimeTaskItems.length
                            )
                          )
                        }
                        className="flex h-8 items-center rounded-md px-2 text-left text-sm font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                      >
                        {t('workbench.expand_display', '展开显示')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`project-runtime-tasks-collapse-${project.id}`}
                        onClick={() =>
                          setRuntimeTaskVisibleLimit(RUNTIME_PROJECT_TASK_PREVIEW_LIMIT)
                        }
                        className="flex h-8 items-center rounded-md px-2 text-left text-sm font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                      >
                        {t('workbench.collapse_display', '折叠显示')}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <ArchiveConversationsConfirmDialog
        open={archiveConfirmOpen}
        title={t('workbench.archive_project_dialog_title', {
          defaultValue: '归档 {{count}} 个对话?',
          count: archiveConversationCount,
        })}
        description={t('workbench.archive_project_dialog_desc', {
          defaultValue: '这会将 {{projectName}} 中的对话归档。之后你可以在已归档对话中找到它们',
          projectName: archiveProjectName,
        })}
        confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={projectArchiving}
        testId={`archive-project-conversations-dialog-${project.id}`}
        onClose={closeArchiveConfirm}
        onConfirm={confirmArchiveProjectConversations}
      />
      <ArchiveConversationsConfirmDialog
        open={removeConfirmOpen}
        title={t('workbench.remove_project_dialog_title', {
          projectName: project.name,
          defaultValue: '移除 {{projectName}}?',
        })}
        description={t('workbench.remove_project_dialog_desc', {
          defaultValue: '这将从 Wework 中移除该项目。磁盘上的文件不会被删除。',
        })}
        confirmLabel={t('workbench.remove_project_dialog_confirm', '移除')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={removingProject}
        testId={`remove-project-dialog-${project.id}`}
        onClose={closeRemoveConfirm}
        onConfirm={confirmRemoveProject}
      />
      <ArchiveConversationsConfirmDialog
        open={forceArchiveConfirmOpen}
        title={t('workbench.archive_runtime_task_dirty_worktree_title')}
        description={t('workbench.archive_runtime_task_dirty_worktree_force_desc')}
        confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
        cancelLabel={t('workbench.cancel', '取消')}
        submitting={projectArchiving}
        testId={`archive-project-force-dialog-${project.id}`}
        onClose={closeForceArchiveConfirm}
        onConfirm={confirmForceArchiveProjectConversations}
      />
    </div>
  )
}

export function DesktopSidebar({
  user,
  projects,
  devices,
  cloudWorkStatus,
  runtimeWork,
  currentRuntimeTask,
  standaloneDeviceId,
  standaloneWorkspacePath,
  imNotificationSettings,
  unreadRuntimeTaskKeys,
  preferredDeviceId,
  activeItem = 'chat',
  onNewChat,
  onStartStandaloneChat,
  onOpenSearch,
  onStartNewProjectChat,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onArchiveProjectConversations,
  onArchiveProjectsConversations,
  onArchiveChatConversations,
  onToggleRuntimeTaskNotification,
  onToggleGlobalImNotification,
  onOpenGlobalImNotificationSettings,
  onOpenPlugins,
  onOpenSites,
  onRefreshDevices,
  onOpenBlankStandaloneProject,
  onOpenStandaloneFolderProject,
  onOpenStandaloneWorkspace,
  onCreatePermanentWorktree,
  onSelectStandaloneDevice,
  onGetRemoteDeviceStartupCommand,
  onUpdateProjectName,
  onRemoveProject,
  onReorderRuntimeProjects,
  onSetRuntimeProjectPinned,
  onSetRuntimeProjectAppearance,
  onReorderRuntimeProjectTasks,
  onSetRuntimeTaskPinned,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenSettings,
  onLogout,
  collapsed = false,
  containerTestId = 'desktop-sidebar',
  hideResizeHandle = false,
  sidebarWidth: sidebarWidthProp,
  resizing: resizingProp,
  onResizeStart: onResizeStartProp,
  onResizeCollapse,
  onResizeStateChange,
  onPointerEnter,
  onPointerLeave,
  onToggleSidebar,
  onOpenWorkbench,
  onOpenTodo,
  onOpenApps,
}: DesktopSidebarProps) {
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const appearanceContext = useOptionalAppearance()
  const appearance = appearanceContext?.appearance ?? defaultAppearance
  const background = getWorkbenchBackground(appearance, appearanceContext?.resolvedMode ?? 'light')
  useSidebarRelativeTimeRefresh()
  const { t } = useTranslation('common')
  const internalResizable = useResizableSidebar({
    onCollapse: onResizeCollapse,
    onResizeStateChange,
  })
  const sidebarWidth = sidebarWidthProp ?? internalResizable.sidebarWidth
  const resizing = resizingProp ?? internalResizable.resizing
  const handleResizeStart = onResizeStartProp ?? internalResizable.handleResizeStart
  const showCloudConnectionEntry = isCloudConnectionUiAvailable()
  const cloud = useOptionalCloudConnection()
  const defaultWegentBackendUrl = getRuntimeConfig().wegentBackendUrl
  const usesCloudAccount = showCloudConnectionEntry && Boolean(defaultWegentBackendUrl)
  const requiresCloudLogin = usesCloudAccount && !cloud.isConnected
  const platform = getPlatform()
  const usesOverlayTitlebar = isTauriRuntime() && platform === 'mac'
  const isWindowsTauri = isTauriRuntime() && platform === 'win'
  const hasAvailableAppUpdate = Boolean(useOptionalAppUpdate()?.availableUpdate)
  const sidebarAccount = requiresCloudLogin
    ? {
        label: t('workbench.account_cloud_title', 'Wegent 账户'),
        detail: t('workbench.account_not_logged_in', '未登录'),
      }
    : getSidebarAccountSummary(
        usesCloudAccount ? cloud.user : user,
        t('workbench.account_fallback', '当前账号')
      )
  const windowFocused = useWindowFocus()

  const storageScope = getDesktopSidebarStorageScope(user)
  const projectsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'projectsExpanded')
  const chatsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'chatsExpanded')
  const expandedProjectIdsStorageKey = getDesktopSidebarStorageKey(
    storageScope,
    'expandedProjectIds'
  )
  const storageScopeRef = useRef(storageScope)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [accountCloudDialogOpen, setAccountCloudDialogOpen] = useState(false)
  const [imNotificationMenuOpen, setImNotificationMenuOpen] = useState(false)
  const [archiveSectionMode, setArchiveSectionMode] = useState<'projects' | 'chats' | null>(null)
  const [forceArchiveSectionMode, setForceArchiveSectionMode] = useState<
    'projects' | 'chats' | null
  >(null)
  const [isArchivingProjectSection, setIsArchivingProjectSection] = useState(false)
  const [isArchivingChatSection, setIsArchivingChatSection] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const projectCreateMenuRef = useRef<HTMLDivElement>(null)
  const projectCreateMenuFloatingRef = useRef<HTMLDivElement>(null)
  const [projectCreateMenuOpen, setProjectCreateMenuOpen] = useState(false)
  const [projectCreateMenuPosition, setProjectCreateMenuPosition] =
    useState<ProjectCreateMenuPosition | null>(null)
  const [blankProjectDialogOpen, setBlankProjectDialogOpen] = useState(false)
  const [standaloneWorkspaceDialogMode, setStandaloneWorkspaceDialogMode] =
    useState<StandaloneWorkspaceDialogMode | null>(null)
  const [standaloneRemoteDialogIntent, setStandaloneRemoteDialogIntent] =
    useState<StandaloneRemoteDialogIntent>('project')
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [projectsExpanded, setProjectsExpanded] = useState(() =>
    readStoredBoolean(projectsExpandedStorageKey, true)
  )
  const [chatsExpanded, setChatsExpanded] = useState(() =>
    readStoredBoolean(chatsExpandedStorageKey, true)
  )
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() =>
    readStoredNumberSet(expandedProjectIdsStorageKey)
  )
  const [chatTaskPinOverrides, setChatTaskPinOverrides] = useState<
    Map<string, RuntimeTaskPinOverride>
  >(() => new Map())
  const chatTaskPinRequestIdRef = useRef(0)
  const [sidebarScrolled, setSidebarScrolled] = useState(false)
  const visibleUnreadRuntimeTaskKeys = unreadRuntimeTaskKeys ?? new Set<string>()
  const sidebarStateDeviceId = getLocalRuntimeStateDeviceId(devices)
  const standaloneProjectWork = useMemo(
    () =>
      standaloneRuntimeProjectWork(
        devices,
        standaloneDeviceId,
        standaloneWorkspacePath,
        runtimeWork
      ),
    [devices, runtimeWork, standaloneDeviceId, standaloneWorkspacePath]
  )
  const sidebarRuntimeProjects = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return standaloneProjectWork ? [standaloneProjectWork, ...items] : items
  }, [runtimeWork?.projects, standaloneProjectWork])
  const sidebarProjects = useMemo(() => {
    if (runtimeWork || standaloneProjectWork) {
      return sidebarRuntimeProjects.map(runtimeProjectToProject)
    }
    return projects
  }, [projects, runtimeWork, sidebarRuntimeProjects, standaloneProjectWork])
  const visibleExpandedProjectIds = useMemo(
    () => pruneProjectIdSet(expandedProjectIds, sidebarProjects),
    [expandedProjectIds, sidebarProjects]
  )
  const runtimeWorkByProjectId = useMemo(() => {
    return new Map(sidebarRuntimeProjects.map(item => [runtimeProjectUiId(item.project), item]))
  }, [sidebarRuntimeProjects])
  const sortableProjects = useMemo(
    () =>
      sidebarProjects.map(project => ({
        project,
        runtimeProjectWork: runtimeWorkByProjectId.get(project.id),
      })),
    [runtimeWorkByProjectId, sidebarProjects]
  )
  const pinnedProjects = useMemo(
    () =>
      sortableProjects
        .filter(({ runtimeProjectWork }) => runtimeProjectWork?.project.pinned)
        .sort(
          (left, right) =>
            (left.runtimeProjectWork?.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.runtimeProjectWork?.project.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
        ),
    [sortableProjects]
  )
  const regularSortableProjects = useMemo(
    () => sortableProjects.filter(({ runtimeProjectWork }) => !runtimeProjectWork?.project.pinned),
    [sortableProjects]
  )
  const chatWorkspaces = useMemo(() => runtimeWork?.chats ?? [], [runtimeWork?.chats])
  const chatTaskItems = useMemo(
    () => getRuntimeChatSidebarTaskItems(chatWorkspaces),
    [chatWorkspaces]
  )
  const chatTaskItemsWithPinState = useMemo(
    () =>
      chatTaskItems.map(item => {
        const threadId = getRuntimeTaskThreadId(item.task)
        const persistedPinned = Boolean(item.task.pinned)
        const override = threadId
          ? chatTaskPinOverrides.get(
              getRuntimeTaskPinOverrideKey(item.workspace.deviceId, threadId)
            )
          : undefined
        const pinned =
          override && override.source === runtimeWork && override.base === persistedPinned
            ? override.value
            : persistedPinned
        return pinned === persistedPinned ? item : { ...item, task: { ...item.task, pinned } }
      }),
    [chatTaskItems, chatTaskPinOverrides, runtimeWork]
  )
  const regularChatTaskItems = useMemo(
    () => chatTaskItemsWithPinState.filter(({ task }) => !task.pinned),
    [chatTaskItemsWithPinState]
  )
  const pinnedTaskItems = useMemo(() => {
    const projectTasks = sidebarRuntimeProjects.flatMap(projectWork =>
      getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces)
        .filter(({ task }) => task.pinned)
        .map(item => ({ ...item, projectWork }))
    )
    const chatTasks = chatTaskItemsWithPinState
      .filter(({ task }) => task.pinned)
      .map(item => ({ ...item, projectWork: null }))
    return [...projectTasks, ...chatTasks].sort(
      (left, right) =>
        (left.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER)
    )
  }, [chatTaskItemsWithPinState, sidebarRuntimeProjects])
  const setChatTaskPinned = async (data: RuntimeTaskPinRequest) => {
    if (!onSetRuntimeTaskPinned) return
    const chatTask = chatTaskItems.find(
      ({ workspace, task }) =>
        workspace.deviceId === data.deviceId && getRuntimeTaskThreadId(task) === data.threadId
    )
    if (!chatTask) {
      await onSetRuntimeTaskPinned(data)
      return
    }

    const key = getRuntimeTaskPinOverrideKey(data.deviceId, data.threadId)
    const requestId = ++chatTaskPinRequestIdRef.current
    const base = Boolean(chatTask.task.pinned)
    setChatTaskPinOverrides(current => {
      const next = new Map(current)
      next.set(key, { base, value: data.pinned, requestId, source: runtimeWork })
      return next
    })
    try {
      await onSetRuntimeTaskPinned(data)
    } catch (error) {
      setChatTaskPinOverrides(current => {
        if (current.get(key)?.requestId !== requestId) return current
        const next = new Map(current)
        next.delete(key)
        return next
      })
      throw error
    }
  }
  const projectSectionArchiveItems = useMemo(() => {
    return sidebarRuntimeProjects
      .map(projectWork => ({
        key: projectWork.project.key,
        count: getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).length,
      }))
      .filter(item => item.count > 0)
  }, [sidebarRuntimeProjects])
  const projectSectionArchiveKeys = useMemo(
    () => projectSectionArchiveItems.map(item => item.key),
    [projectSectionArchiveItems]
  )
  const projectSectionArchiveCount = useMemo(
    () => projectSectionArchiveItems.reduce((total, item) => total + item.count, 0),
    [projectSectionArchiveItems]
  )
  const chatSectionArchiveAddresses = useMemo(
    () => chatTaskItems.map(({ workspace, task }) => getRuntimeTaskAddress(workspace, task)),
    [chatTaskItems]
  )
  const chatSectionArchiveCount = chatSectionArchiveAddresses.length
  const selectedRuntimeProject = useMemo(() => {
    if (currentRuntimeTask) {
      const projectWork = sidebarRuntimeProjects.find(item =>
        item.deviceWorkspaces.some(workspace =>
          workspace.tasks.some(task => isRuntimeTaskSelected(currentRuntimeTask, workspace, task))
        )
      )
      return projectWork
        ? {
            autoExpandKey: `task:${getRuntimeNotificationKey(currentRuntimeTask)}`,
            id: runtimeProjectUiId(projectWork.project),
          }
        : null
    }

    const normalizedDeviceId = standaloneDeviceId?.trim()
    const normalizedWorkspacePath = standaloneWorkspacePath
      ? normalizeSidebarWorkspacePath(standaloneWorkspacePath)
      : ''
    if (!normalizedDeviceId || !normalizedWorkspacePath) return null

    const projectWork = sidebarRuntimeProjects.find(item =>
      item.deviceWorkspaces.some(
        workspace =>
          workspace.deviceId === normalizedDeviceId &&
          normalizeSidebarWorkspacePath(workspace.workspacePath) === normalizedWorkspacePath
      )
    )
    return projectWork
      ? {
          autoExpandKey: `workspace:${normalizedDeviceId}:${normalizedWorkspacePath}`,
          id: runtimeProjectUiId(projectWork.project),
        }
      : null
  }, [currentRuntimeTask, sidebarRuntimeProjects, standaloneDeviceId, standaloneWorkspacePath])
  const selectedRuntimeProjectId = selectedRuntimeProject?.id ?? null
  const selectedRuntimeProjectAutoExpandKey = selectedRuntimeProject?.autoExpandKey ?? null
  const selectedRuntimeChatVisible = useMemo(() => {
    if (!currentRuntimeTask) return false
    return regularChatTaskItems.some(({ workspace, task }) =>
      isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
    )
  }, [currentRuntimeTask, regularChatTaskItems])
  const displayedProjectsExpanded = projectsExpanded
  const displayedChatsExpanded = chatsExpanded || selectedRuntimeChatVisible
  const isArchiveSectionSubmitting =
    archiveSectionMode === 'projects' ? isArchivingProjectSection : isArchivingChatSection
  const archiveSectionDialogTestId =
    archiveSectionMode === 'chats'
      ? 'runtime-chat-section-archive-conversations-dialog'
      : 'projects-section-archive-conversations-dialog'
  const archiveSectionDialogCount =
    archiveSectionMode === 'chats' ? chatSectionArchiveCount : projectSectionArchiveCount
  const closeArchiveSectionDialog = () => {
    if (!isArchiveSectionSubmitting) {
      setArchiveSectionMode(null)
    }
  }
  const forceArchiveSectionDialogTestId =
    forceArchiveSectionMode === 'chats'
      ? 'runtime-chat-section-force-archive-dialog'
      : 'projects-section-force-archive-dialog'
  const runArchiveSectionConversations = async (
    mode: 'projects' | 'chats',
    options?: ArchiveRuntimeTaskOptions
  ) => {
    if (mode === 'projects') {
      if (!onArchiveProjectsConversations || projectSectionArchiveKeys.length === 0) return
      setIsArchivingProjectSection(true)
      try {
        const result = await onArchiveProjectsConversations(projectSectionArchiveKeys, options)
        if (result?.status === 'dirty_worktree') {
          setArchiveSectionMode(null)
          setForceArchiveSectionMode('projects')
          return
        }
        setArchiveSectionMode(null)
        setForceArchiveSectionMode(null)
      } finally {
        setIsArchivingProjectSection(false)
      }
      return
    }

    if (mode === 'chats') {
      if (!onArchiveChatConversations || chatSectionArchiveAddresses.length === 0) return
      setIsArchivingChatSection(true)
      try {
        const result = await onArchiveChatConversations(chatSectionArchiveAddresses, options)
        if (result?.status === 'dirty_worktree') {
          setArchiveSectionMode(null)
          setForceArchiveSectionMode('chats')
          return
        }
        setArchiveSectionMode(null)
        setForceArchiveSectionMode(null)
      } finally {
        setIsArchivingChatSection(false)
      }
    }
  }
  const confirmArchiveSectionConversations = () => {
    if (!archiveSectionMode) return
    void runArchiveSectionConversations(archiveSectionMode)
  }
  const closeForceArchiveSectionDialog = () => {
    if (!isArchiveSectionSubmitting) {
      setForceArchiveSectionMode(null)
    }
  }
  const confirmForceArchiveSectionConversations = () => {
    if (!forceArchiveSectionMode) return
    void runArchiveSectionConversations(forceArchiveSectionMode, { force: true })
  }
  const displayedExpandedProjectIds = visibleExpandedProjectIds
  const autoExpandedProjectKeyRef = useRef<string | null>(null)

  const handleToggleProject = (projectId: number) => {
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  useEffect(() => {
    if (selectedRuntimeProjectId === null || !selectedRuntimeProjectAutoExpandKey) return

    const scopedAutoExpandKey = `${storageScope}:${selectedRuntimeProjectAutoExpandKey}`
    if (autoExpandedProjectKeyRef.current === scopedAutoExpandKey) return

    autoExpandedProjectKeyRef.current = scopedAutoExpandKey
    setProjectsExpanded(true)
    setExpandedProjectIds(previous => {
      if (previous.has(selectedRuntimeProjectId)) return previous
      return new Set([...previous, selectedRuntimeProjectId])
    })
  }, [selectedRuntimeProjectAutoExpandKey, selectedRuntimeProjectId, storageScope])

  const openProjectCreateMenu = (anchor: HTMLElement) => {
    setProjectCreateMenuOpen(open => {
      if (open) return false

      const anchorRect = anchor.getBoundingClientRect()
      const maxLeft = Math.max(
        PROJECT_CREATE_MENU_MARGIN,
        window.innerWidth - PROJECT_CREATE_MENU_WIDTH - PROJECT_CREATE_MENU_MARGIN
      )
      setProjectCreateMenuPosition({
        top: Math.max(PROJECT_CREATE_MENU_MARGIN, anchorRect.bottom + PROJECT_CREATE_MENU_MARGIN),
        left: Math.min(anchorRect.right + PROJECT_CREATE_MENU_MARGIN, maxLeft),
      })
      return true
    })
    void onRefreshDevices?.().catch(() => undefined)
  }

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredBoolean(projectsExpandedStorageKey, projectsExpanded)
  }, [projectsExpanded, projectsExpandedStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredBoolean(chatsExpandedStorageKey, chatsExpanded)
  }, [chatsExpanded, chatsExpandedStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredNumberSet(expandedProjectIdsStorageKey, expandedProjectIds)
  }, [expandedProjectIds, expandedProjectIdsStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current === storageScope) return

    storageScopeRef.current = storageScope
    setProjectsExpanded(readStoredBoolean(projectsExpandedStorageKey, true))
    setChatsExpanded(readStoredBoolean(chatsExpandedStorageKey, true))
    setExpandedProjectIds(readStoredNumberSet(expandedProjectIdsStorageKey))
  }, [
    chatsExpandedStorageKey,
    expandedProjectIdsStorageKey,
    projectsExpandedStorageKey,
    storageScope,
  ])

  useEffect(() => {
    if (!settingsMenuOpen && !imNotificationMenuOpen) {
      return
    }

    const handleOutsidePointer = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
      if (!settingsMenuRef.current?.contains(event.target as Node)) {
        setSettingsMenuOpen(false)
        setImNotificationMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointer)
    document.addEventListener('mousedown', handleOutsidePointer)

    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      document.removeEventListener('mousedown', handleOutsidePointer)
    }
  }, [imNotificationMenuOpen, settingsMenuOpen])

  useEffect(() => {
    if (!projectCreateMenuOpen) return

    const handleOutsidePointer = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
      const target = event.target as Node
      if (
        !projectCreateMenuRef.current?.contains(target) &&
        !projectCreateMenuFloatingRef.current?.contains(target)
      ) {
        setProjectCreateMenuOpen(false)
      }
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProjectCreateMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointer)
    document.addEventListener('mousedown', handleOutsidePointer)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      document.removeEventListener('mousedown', handleOutsidePointer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [projectCreateMenuOpen])

  useEffect(() => {
    if (!currentRuntimeTask) return

    const taskRow = document.querySelector(
      `[data-testid="runtime-local-task-row-${currentRuntimeTask.taskId}"]`
    )

    taskRow?.scrollIntoView({ block: 'nearest' })
  }, [
    currentRuntimeTask,
    displayedChatsExpanded,
    displayedExpandedProjectIds,
    displayedProjectsExpanded,
  ])

  return (
    <aside
      data-testid={containerTestId}
      data-window-focused={windowFocused}
      data-sidebar-translucent={
        isWindowsTauri && !(background.imagePath && background.inSidebar) ? 'false' : undefined
      }
      aria-hidden={collapsed}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        'relative z-popover h-full shrink-0 overflow-visible transition-[width,background-color] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none will-change-[width]',
        !isWindowsTauri && 'border-r border-black/[0.08] dark:border-white/[0.08]',
        background.imagePath && background.inSidebar
          ? 'bg-background/25'
          : 'bg-[rgb(var(--color-sidebar))] backdrop-blur-xl backdrop-saturate-150',
        !windowFocused &&
          !(background.imagePath && background.inSidebar) &&
          'bg-[rgb(var(--color-sidebar-unfocused))]',
        resizing && 'transition-none',
        collapsed && 'pointer-events-none'
      )}
      style={{ width: collapsed ? 0 : sidebarWidth }}
    >
      <div className="h-full overflow-hidden">
        <div
          className={cn(
            'relative flex h-full flex-col px-1.5',
            usesOverlayTitlebar ? 'pt-[44px]' : 'pt-1.5'
          )}
          style={{ width: sidebarWidth }}
        >
          {usesOverlayTitlebar && (
            <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          )}
          {usesOverlayTitlebar && onToggleSidebar && (
            <div
              data-testid="desktop-sidebar-chrome-controls"
              className={cn(
                'absolute top-0 z-chrome flex h-[38px] items-center gap-1',
                MACOS_WINDOW_CONTROLS_SAFE_AREA_CLASS
              )}
            >
              <DesktopWindowControls
                sidebarCollapsed={false}
                onToggleSidebar={onToggleSidebar}
                className="gap-1"
              />
              <DesktopAppSwitcher
                activeApp={
                  activeItem === 'todo' ? 'todo' : activeItem === 'plugins' ? 'apps' : 'wework'
                }
                onNavigate={app => {
                  if (app === 'wework') onOpenWorkbench?.()
                  if (app === 'todo') onOpenTodo?.()
                  if (app === 'apps') onOpenApps?.()
                  if (app === 'wegent') navigateTo('/app/wegent')
                }}
              />
            </div>
          )}
          <div className="mb-1 flex h-9 items-center justify-between px-2">
            <span className="min-w-0 truncate text-heading-sm font-semibold leading-6 text-[rgb(var(--color-sidebar-text-primary))]">
              Wework
            </span>
            {onOpenSearch && (
              <button
                type="button"
                data-testid="runtime-search-button"
                onClick={onOpenSearch}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                title={t('workbench.search')}
                aria-label={t('workbench.search')}
              >
                <Search className="h-4 w-4" />
              </button>
            )}
          </div>
          <nav className="space-y-0.5">
            <SidebarButton
              icon={Plus}
              label={t('workbench.new_task')}
              testId="new-chat-button"
              onClick={onNewChat}
            />
          </nav>

          <div
            data-testid="sidebar-worklists-scroll"
            data-scrolled={sidebarScrolled}
            onScroll={event => setSidebarScrolled(event.currentTarget.scrollTop > 0)}
            className={cn(
              'scrollbar-none relative mb-2 mt-0.5 min-h-0 flex-1 overflow-y-auto pb-3 [overflow-anchor:none] [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_16px),transparent_100%)]',
              sidebarScrolled &&
                '[mask-image:linear-gradient(to_bottom,transparent_0,black_12px,black_calc(100%_-_16px),transparent_100%)]'
            )}
          >
            <nav className="mb-4 space-y-0.5">
              {SHOW_PLUGINS_NAVIGATION && (
                <SidebarButton
                  icon={Sparkles}
                  label={t('workbench.plugins', '插件')}
                  testId="plugins-button"
                  selected={activeItem === 'plugins'}
                  onClick={onOpenPlugins}
                />
              )}
              {(experimentalFeaturesEnabled || activeItem === 'sites') && (
                <SidebarButton
                  icon={Grid3X3}
                  label={t('workbench.sites', '站点')}
                  testId="sites-button"
                  selected={activeItem === 'sites'}
                  onClick={onOpenSites ?? (() => navigateTo('/sites'))}
                />
              )}
              {showCloudConnectionEntry && (
                <CloudConnectionSidebarButton
                  devices={devices}
                  cloudWorkStatus={cloudWorkStatus}
                  onOpenSettings={() => onOpenSettings({ settingsPage: 'connections' })}
                  onSelectCloudDevice={deviceId => onSelectStandaloneDevice?.(deviceId)}
                  onAddDevice={() => {
                    if (onOpenStandaloneFolderProject) {
                      onOpenStandaloneFolderProject('remote', 'add-device')
                    } else {
                      setStandaloneRemoteDialogIntent('add-device')
                      setStandaloneWorkspaceDialogMode('remote')
                    }
                  }}
                />
              )}
            </nav>
            {(pinnedTaskItems.length > 0 || pinnedProjects.length > 0) && (
              <section data-testid="sidebar-pinned-section" className="mb-5">
                <div
                  data-testid="sidebar-pinned-section-header"
                  className="mb-1 flex h-[30px] items-center px-2.5 text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75"
                >
                  {t('workbench.pinned')}
                </div>
                {pinnedTaskItems.length > 0 && (
                  <SidebarSortableList
                    testId="pinned-runtime-task-sortable-list"
                    className="space-y-0.5"
                    items={pinnedTaskItems}
                    getId={({ workspace, task }) =>
                      `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
                    }
                    getLabel={({ task }) => task.title}
                    canDrag={({ task }) =>
                      Boolean(getRuntimeTaskThreadId(task) && onSetRuntimeTaskPinned)
                    }
                    onMove={async (moved, before) => {
                      const movedThreadId = getRuntimeTaskThreadId(moved.task)
                      if (!movedThreadId || !onSetRuntimeTaskPinned) {
                        throw new Error('Pinned task ordering is unavailable')
                      }
                      const movedDeviceId =
                        moved.projectWork?.project.stateDeviceId || moved.workspace.deviceId
                      const beforeDeviceId =
                        before?.projectWork?.project.stateDeviceId || before?.workspace.deviceId
                      if (beforeDeviceId && beforeDeviceId !== movedDeviceId) {
                        throw new Error('Pinned tasks from different devices cannot be reordered')
                      }
                      await onSetRuntimeTaskPinned({
                        deviceId: movedDeviceId,
                        threadId: movedThreadId,
                        pinned: true,
                        beforeThreadId: before ? getRuntimeTaskThreadId(before.task) : null,
                      })
                    }}
                    renderItem={({ workspace, task, projectWork }) => (
                      <RuntimeTaskRow
                        workspace={workspace}
                        task={task}
                        projectName={projectWork?.project.name}
                        selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                        unread={visibleUnreadRuntimeTaskKeys.has(
                          getRuntimeTaskReminderItemKey(workspace, task)
                        )}
                        marked
                        indentClassName="pl-2.5"
                        imNotificationSettings={imNotificationSettings}
                        showDeviceMarker={false}
                        stateDeviceId={projectWork?.project.stateDeviceId || workspace.deviceId}
                        onOpenRuntimeTask={onOpenRuntimeTask}
                        onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                        onSetRuntimeTaskPinned={
                          projectWork || !onSetRuntimeTaskPinned
                            ? onSetRuntimeTaskPinned
                            : setChatTaskPinned
                        }
                        onRenameRuntimeTask={onRenameRuntimeTask}
                        onArchiveRuntimeTask={onArchiveRuntimeTask}
                        onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                      />
                    )}
                  />
                )}
                {pinnedProjects.length > 0 && (
                  <SidebarSortableList
                    testId="pinned-runtime-project-sortable-list"
                    className="mt-1 space-y-1"
                    items={pinnedProjects}
                    getId={({ runtimeProjectWork }) =>
                      `${sidebarStateDeviceId || runtimeProjectWork?.project.stateDeviceId || 'device'}:${runtimeProjectWork ? getRuntimeProjectSidebarStateKey(runtimeProjectWork.project) : 'project'}`
                    }
                    getLabel={({ project }) => project.name}
                    canDrag={({ runtimeProjectWork }) =>
                      Boolean(runtimeProjectWork?.project.key && onSetRuntimeProjectPinned)
                    }
                    onMove={async (moved, before) => {
                      const movedProject = moved.runtimeProjectWork?.project
                      const beforeProject = before?.runtimeProjectWork?.project
                      const deviceId =
                        sidebarStateDeviceId ||
                        movedProject?.stateDeviceId ||
                        moved.runtimeProjectWork?.deviceWorkspaces[0]?.deviceId
                      if (!movedProject || !deviceId || !onSetRuntimeProjectPinned) {
                        throw new Error('Pinned project ordering is unavailable')
                      }
                      await onSetRuntimeProjectPinned({
                        deviceId,
                        projectKey: getRuntimeProjectSidebarStateKey(movedProject),
                        pinned: true,
                        beforeProjectKey: beforeProject
                          ? getRuntimeProjectSidebarStateKey(beforeProject)
                          : null,
                      })
                    }}
                    renderItem={({ project, runtimeProjectWork }) => (
                      <ProjectItem
                        project={project}
                        expanded={displayedExpandedProjectIds.has(project.id)}
                        devices={devices}
                        runtimeProjectWork={runtimeProjectWork}
                        currentRuntimeTask={currentRuntimeTask}
                        unreadTaskKeys={visibleUnreadRuntimeTaskKeys}
                        imNotificationSettings={imNotificationSettings}
                        showDeviceMarker={false}
                        sidebarStateDeviceId={sidebarStateDeviceId}
                        onToggleProject={handleToggleProject}
                        onStartNewProjectChat={onStartNewProjectChat}
                        onRemoveProject={onRemoveProject}
                        onCreatePermanentWorktree={onCreatePermanentWorktree}
                        onReorderRuntimeProjects={onReorderRuntimeProjects}
                        onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
                        onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
                        onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
                        onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
                        onRenameProject={setRenamingProject}
                        onOpenRuntimeTask={onOpenRuntimeTask}
                        onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                        onRenameRuntimeTask={onRenameRuntimeTask}
                        onArchiveRuntimeTask={onArchiveRuntimeTask}
                        onArchiveProjectConversations={onArchiveProjectConversations}
                        onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                      />
                    )}
                  />
                )}
              </section>
            )}
            <section>
              <div ref={projectCreateMenuRef}>
                <SidebarSectionHeader
                  title={t('workbench.projects', '项目')}
                  expanded={displayedProjectsExpanded}
                  hasContent={sidebarProjects.length > 0}
                  toggleTestId="projects-section-toggle"
                  iconTestId="projects-section-chevron-right"
                  onToggle={() => setProjectsExpanded(expanded => !expanded)}
                >
                  <div className="flex items-center">
                    <ActionMenu
                      ariaLabel={t('workbench.project_list_actions', '项目列表操作')}
                      testId="projects-section-menu"
                      items={[
                        {
                          label: t('workbench.archive_all_chats', '归档所有聊天'),
                          icon: Archive,
                          testId: 'projects-section-archive-all-chats',
                          disabled:
                            !onArchiveProjectsConversations ||
                            projectSectionArchiveCount === 0 ||
                            isArchivingProjectSection,
                          onSelect: () => setArchiveSectionMode('projects'),
                        },
                      ]}
                      triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                    />
                    <button
                      type="button"
                      aria-label={t('workbench.new_project', '新建项目')}
                      data-testid="projects-create-button"
                      onClick={event => {
                        event.stopPropagation()
                        openProjectCreateMenu(event.currentTarget)
                      }}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                      aria-expanded={projectCreateMenuOpen}
                    >
                      <FolderPlus className="h-4 w-4" />
                    </button>
                  </div>
                </SidebarSectionHeader>
              </div>
              {projectCreateMenuOpen &&
                projectCreateMenuPosition &&
                createPortal(
                  <div
                    ref={projectCreateMenuFloatingRef}
                    data-testid="projects-create-button-menu"
                    className="fixed z-modal rounded-xl border border-border bg-surface p-1.5 text-sm text-text-primary shadow-lg"
                    style={{
                      top: projectCreateMenuPosition.top,
                      left: projectCreateMenuPosition.left,
                      width: PROJECT_CREATE_MENU_WIDTH,
                    }}
                    onClick={event => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      data-testid="project-create-blank-option"
                      onClick={() => {
                        setProjectCreateMenuOpen(false)
                        if (onOpenBlankStandaloneProject) {
                          onOpenBlankStandaloneProject()
                        } else {
                          setBlankProjectDialogOpen(true)
                        }
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted"
                    >
                      <FolderPlus className="h-4 w-4 shrink-0 text-text-secondary" />
                      <span className="truncate">
                        {t('workbench.new_blank_project', '新建空白项目')}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid="project-create-existing-option"
                      onClick={() => {
                        setProjectCreateMenuOpen(false)
                        if (onOpenStandaloneFolderProject) {
                          onOpenStandaloneFolderProject('existing')
                        } else {
                          setStandaloneWorkspaceDialogMode('existing')
                        }
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted"
                    >
                      <FolderPlus className="h-4 w-4 shrink-0 text-text-secondary" />
                      <span className="truncate">
                        {t('workbench.use_existing_folder', '使用现有文件夹')}
                      </span>
                    </button>
                    <div className="my-1 border-t border-border" />
                    <button
                      type="button"
                      data-testid="project-create-remote-option"
                      onClick={() => {
                        setProjectCreateMenuOpen(false)
                        if (onOpenStandaloneFolderProject) {
                          onOpenStandaloneFolderProject('remote', 'project')
                        } else {
                          setStandaloneRemoteDialogIntent('project')
                          setStandaloneWorkspaceDialogMode('remote')
                        }
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-muted"
                    >
                      <Globe2 className="h-4 w-4 shrink-0 text-text-secondary" />
                      <span className="truncate">{t('workbench.remote_project', '远程项目')}</span>
                    </button>
                  </div>,
                  document.body
                )}
              {displayedProjectsExpanded && (
                <SidebarSortableList
                  testId="runtime-project-sortable-list"
                  className="space-y-1"
                  items={regularSortableProjects}
                  getId={({ project, runtimeProjectWork }) =>
                    runtimeProjectWork
                      ? `${sidebarStateDeviceId || runtimeProjectWork.project.stateDeviceId || 'device'}:${getRuntimeProjectSidebarStateKey(runtimeProjectWork.project)}`
                      : `project:${project.id}`
                  }
                  getLabel={({ project }) => project.name}
                  canDrag={({ runtimeProjectWork }) =>
                    Boolean(runtimeProjectWork?.project.key && onReorderRuntimeProjects)
                  }
                  onMove={async (moved, before) => {
                    const movedRuntimeProject = moved.runtimeProjectWork
                    if (!movedRuntimeProject || !onReorderRuntimeProjects) {
                      throw new Error('Runtime project ordering is unavailable')
                    }
                    const request = getRuntimeProjectReorderRequest(
                      movedRuntimeProject,
                      before?.runtimeProjectWork,
                      sidebarStateDeviceId
                    )
                    if (!request) throw new Error('Runtime project ordering is unavailable')
                    await onReorderRuntimeProjects(request)
                  }}
                  renderItem={({ project, runtimeProjectWork }) => (
                    <ProjectItem
                      project={project}
                      expanded={displayedExpandedProjectIds.has(project.id)}
                      devices={devices}
                      runtimeProjectWork={runtimeProjectWork}
                      currentRuntimeTask={currentRuntimeTask}
                      unreadTaskKeys={visibleUnreadRuntimeTaskKeys}
                      imNotificationSettings={imNotificationSettings}
                      showDeviceMarker={false}
                      sidebarStateDeviceId={sidebarStateDeviceId}
                      onToggleProject={handleToggleProject}
                      onStartNewProjectChat={onStartNewProjectChat}
                      onRemoveProject={onRemoveProject}
                      onCreatePermanentWorktree={onCreatePermanentWorktree}
                      onReorderRuntimeProjects={onReorderRuntimeProjects}
                      onSetRuntimeProjectPinned={onSetRuntimeProjectPinned}
                      onSetRuntimeProjectAppearance={onSetRuntimeProjectAppearance}
                      onReorderRuntimeProjectTasks={onReorderRuntimeProjectTasks}
                      onSetRuntimeTaskPinned={onSetRuntimeTaskPinned}
                      onRenameProject={setRenamingProject}
                      onOpenRuntimeTask={onOpenRuntimeTask}
                      onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                      onRenameRuntimeTask={onRenameRuntimeTask}
                      onArchiveRuntimeTask={onArchiveRuntimeTask}
                      onArchiveProjectConversations={onArchiveProjectConversations}
                      onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                    />
                  )}
                />
              )}
            </section>

            <section data-testid="runtime-chat-section" className="mt-8">
              <SidebarSectionHeader
                title={t('workbench.tasks')}
                expanded={displayedChatsExpanded}
                hasContent={regularChatTaskItems.length > 0}
                toggleTestId="runtime-chat-section-toggle"
                iconTestId="runtime-chat-section-chevron-right"
                onToggle={() => setChatsExpanded(expanded => !expanded)}
              >
                <div className="flex items-center">
                  <ActionMenu
                    ariaLabel={t('workbench.chat_list_actions', '对话列表操作')}
                    testId="runtime-chat-section-menu"
                    items={[
                      {
                        label: t('workbench.archive_all_chats', '归档所有聊天'),
                        icon: Archive,
                        testId: 'runtime-chat-section-archive-all-chats',
                        disabled:
                          !onArchiveChatConversations ||
                          chatSectionArchiveCount === 0 ||
                          isArchivingChatSection,
                        onSelect: () => setArchiveSectionMode('chats'),
                      },
                    ]}
                    triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                  />
                  <button
                    type="button"
                    aria-label={t('workbench.new_task')}
                    data-testid="runtime-chat-section-new-chat-button"
                    onClick={event => {
                      event.stopPropagation()
                      onStartStandaloneChat()
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </button>
                </div>
              </SidebarSectionHeader>
              {displayedChatsExpanded && (
                <div className="space-y-0.5 pb-2">
                  {regularChatTaskItems.length === 0 ? (
                    <div
                      data-testid="runtime-chat-empty"
                      className="ml-2 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
                    >
                      {t('workbench.no_chats', '暂无会话')}
                    </div>
                  ) : (
                    <SidebarSortableList
                      testId="runtime-chat-task-sortable-list"
                      className="space-y-0.5"
                      items={regularChatTaskItems}
                      getId={({ workspace, task }) =>
                        `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
                      }
                      getLabel={({ task }) => task.title}
                      canDrag={({ task }) =>
                        Boolean(getRuntimeTaskThreadId(task) && onReorderRuntimeProjectTasks)
                      }
                      onMove={async (moved, before) => {
                        const movedThreadId = getRuntimeTaskThreadId(moved.task)
                        if (!movedThreadId || !onReorderRuntimeProjectTasks) {
                          throw new Error('Runtime task ordering is unavailable')
                        }
                        if (before && before.workspace.deviceId !== moved.workspace.deviceId) {
                          throw new Error(
                            'Tasks from different devices cannot be reordered together'
                          )
                        }
                        const beforeThreadId = before ? getRuntimeTaskThreadId(before.task) : null
                        await onReorderRuntimeProjectTasks({
                          deviceId: moved.workspace.deviceId,
                          projectKey: 'chats',
                          threadId: movedThreadId,
                          beforeThreadId,
                          insertAtEnd: beforeThreadId === null,
                        })
                      }}
                      renderItem={({ workspace, task }) => (
                        <RuntimeTaskRow
                          workspace={workspace}
                          task={task}
                          projectName={null}
                          selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                          unread={visibleUnreadRuntimeTaskKeys.has(
                            getRuntimeTaskReminderItemKey(workspace, task)
                          )}
                          indentClassName="pl-2.5"
                          imNotificationSettings={imNotificationSettings}
                          showDeviceMarker={false}
                          stateDeviceId={workspace.deviceId}
                          onOpenRuntimeTask={onOpenRuntimeTask}
                          onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                          onRenameRuntimeTask={onRenameRuntimeTask}
                          onArchiveRuntimeTask={onArchiveRuntimeTask}
                          onSetRuntimeTaskPinned={
                            onSetRuntimeTaskPinned ? setChatTaskPinned : undefined
                          }
                          onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                        />
                      )}
                    />
                  )}
                </div>
              )}
            </section>
          </div>

          <div ref={settingsMenuRef} className="group/account relative shrink-0">
            <div className="relative flex h-[60px] items-center rounded-[10px] transition-colors group-hover/account:bg-[rgb(var(--color-sidebar-hover))] group-focus-within/account:bg-[rgb(var(--color-sidebar-hover))]">
              <button
                type="button"
                data-testid="settings-button"
                onClick={() => {
                  setImNotificationMenuOpen(false)
                  setSettingsMenuOpen(open => !open)
                }}
                className={cn(
                  'flex h-[60px] min-w-0 flex-1 items-center gap-3 rounded-[10px] py-2 pl-1.5 text-left text-[rgb(var(--color-sidebar-text-primary))]',
                  hasAvailableAppUpdate ? 'pr-[72px]' : 'pr-10'
                )}
                title={t('workbench.account_and_settings', '账户与设置')}
                aria-label={t('workbench.account_and_settings', '账户与设置')}
                aria-expanded={settingsMenuOpen}
              >
                <span
                  data-testid="sidebar-account-avatar"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary"
                >
                  <UserRound className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold leading-[18px]">
                    {sidebarAccount.label}
                  </span>
                  <span className="block truncate text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-secondary))]">
                    {sidebarAccount.detail}
                  </span>
                </span>
              </button>
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                {hasAvailableAppUpdate && (
                  <div data-testid="sidebar-app-update-action">
                    <SidebarAppUpdateButton
                      onBeforeInstall={() => {
                        setSettingsMenuOpen(false)
                        setImNotificationMenuOpen(false)
                      }}
                    />
                  </div>
                )}
                {experimentalFeaturesEnabled && (
                  <GlobalImNotificationBell
                    devices={devices}
                    imNotificationSettings={imNotificationSettings}
                    menuOpen={imNotificationMenuOpen}
                    menuContainerRef={settingsMenuRef}
                    onMenuOpenChange={open => {
                      if (open) setSettingsMenuOpen(false)
                      setImNotificationMenuOpen(open)
                    }}
                    onToggleGlobalImNotification={onToggleGlobalImNotification}
                    onOpenGlobalImNotificationSettings={onOpenGlobalImNotificationSettings}
                    onOpenSettings={() => onOpenSettings()}
                    onAddCloudDevice={() => {
                      if (onOpenStandaloneFolderProject) {
                        onOpenStandaloneFolderProject('remote', 'add-device')
                      } else {
                        setStandaloneRemoteDialogIntent('add-device')
                        setStandaloneWorkspaceDialogMode('remote')
                      }
                    }}
                  />
                )}
              </div>
              {settingsMenuOpen && (
                <DesktopSettingsMenu
                  user={user}
                  showLogout={usesCloudAccount ? cloud.isConnected : undefined}
                  onOpenSettings={() => {
                    setSettingsMenuOpen(false)
                    onOpenSettings()
                  }}
                  onLogin={
                    requiresCloudLogin
                      ? () => {
                          setSettingsMenuOpen(false)
                          setAccountCloudDialogOpen(true)
                        }
                      : undefined
                  }
                  onLogout={() => {
                    setSettingsMenuOpen(false)
                    if (usesCloudAccount) {
                      cloud.disconnect()
                      return
                    }
                    onLogout()
                  }}
                />
              )}
            </div>
          </div>

          {accountCloudDialogOpen && (
            <CloudConnectionDialog
              open
              onlineCloudDeviceCount={0}
              onClose={() => setAccountCloudDialogOpen(false)}
              onOpenSettings={() => {
                setAccountCloudDialogOpen(false)
                onOpenSettings({ settingsPage: 'connections' })
              }}
            />
          )}

          <StandaloneBlankProjectDialog
            open={blankProjectDialogOpen}
            devices={devices}
            preferredDeviceId={preferredDeviceId}
            onClose={() => setBlankProjectDialogOpen(false)}
            onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
            onListDeviceDirectories={onListDeviceDirectories}
            onCreateDeviceDirectory={onCreateDeviceDirectory}
            onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
          />
          <StandaloneFolderProjectDialog
            key={standaloneWorkspaceDialogMode ?? 'standalone-folder-closed'}
            open={standaloneWorkspaceDialogMode !== null}
            mode={standaloneWorkspaceDialogMode ?? 'existing'}
            remoteIntent={standaloneRemoteDialogIntent}
            devices={devices}
            preferredDeviceId={preferredDeviceId}
            onClose={() => setStandaloneWorkspaceDialogMode(null)}
            onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
            onListDeviceDirectories={onListDeviceDirectories}
            onCreateDeviceDirectory={onCreateDeviceDirectory}
            onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
            onGetRemoteDeviceStartupCommand={onGetRemoteDeviceStartupCommand}
            onRefreshDevices={onRefreshDevices}
          />
          <ArchiveConversationsConfirmDialog
            open={archiveSectionMode !== null}
            title={t(
              archiveSectionMode === 'chats'
                ? 'workbench.archive_chats_dialog_title'
                : 'workbench.archive_projects_dialog_title',
              {
                defaultValue: '归档 {{count}} 个对话?',
                count: archiveSectionDialogCount,
              }
            )}
            description={t(
              archiveSectionMode === 'chats'
                ? 'workbench.archive_chats_dialog_desc'
                : 'workbench.archive_projects_dialog_desc',
              {
                defaultValue:
                  archiveSectionMode === 'chats'
                    ? '这会将对话列表中的对话归档。之后你可以在已归档对话中找到它们'
                    : '这会将项目中的对话归档。之后你可以在已归档对话中找到它们',
              }
            )}
            confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
            cancelLabel={t('workbench.cancel', '取消')}
            submitting={isArchiveSectionSubmitting}
            testId={archiveSectionDialogTestId}
            onClose={closeArchiveSectionDialog}
            onConfirm={confirmArchiveSectionConversations}
          />
          <ArchiveConversationsConfirmDialog
            open={forceArchiveSectionMode !== null}
            title={t('workbench.archive_runtime_task_dirty_worktree_title')}
            description={t('workbench.archive_runtime_tasks_dirty_worktree_force_desc')}
            confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
            cancelLabel={t('workbench.cancel', '取消')}
            submitting={isArchiveSectionSubmitting}
            testId={forceArchiveSectionDialogTestId}
            onClose={closeForceArchiveSectionDialog}
            onConfirm={confirmForceArchiveSectionConversations}
          />
          <TextInputDialog
            open={renamingProject !== null}
            title={t('workbench.rename_project', '重命名项目')}
            label={t('workbench.project_name', '项目名称')}
            initialValue={renamingProject?.name ?? ''}
            confirmLabel={t('workbench.save', '保存')}
            cancelLabel={t('workbench.cancel', '取消')}
            inputTestId="rename-project-input"
            confirmTestId="confirm-rename-project-button"
            onClose={() => setRenamingProject(null)}
            onSubmit={name =>
              renamingProject ? onUpdateProjectName(renamingProject.id, name) : Promise.resolve()
            }
          />
        </div>
      </div>

      {!collapsed && !hideResizeHandle && (
        <button
          type="button"
          data-testid="sidebar-resize-handle"
          onPointerDown={handleResizeStart}
          className="absolute right-[-14px] top-0 z-[80] h-full w-[18px] cursor-col-resize touch-none bg-transparent after:absolute after:left-1 after:top-0 after:h-full after:w-px after:bg-transparent after:transition-colors after:duration-150 hover:after:bg-primary/35"
          aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
        />
      )}
    </aside>
  )
}
