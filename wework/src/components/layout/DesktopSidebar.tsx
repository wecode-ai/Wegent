import {
  Archive,
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
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
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEventHandler,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
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
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { runtimeProjectToProject, runtimeProjectUiId } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
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
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudWorkStatus } from '@/types/workbench'
import type {
  ArchiveRuntimeConversationsResult,
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'
import { DesktopWindowControls } from './DesktopWindowControls'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
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
  type RuntimeSidebarTaskItem,
} from './runtimeTaskSidebarHelpers'
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
  activeItem?: 'chat' | 'plugins' | 'automation'
  collapsed?: boolean
  containerTestId?: string
  hideResizeHandle?: boolean
  onResizeCollapse?: () => void
  onResizeStateChange?: (resizing: boolean) => void
  onPointerEnter?: PointerEventHandler<HTMLElement>
  onPointerLeave?: PointerEventHandler<HTMLElement>
  onToggleSidebar?: () => void
  onOpenWorkbench?: () => void
  onOpenApps?: () => void
  onNewChat: () => void
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
  onRefreshDevices?: () => Promise<void>
  onOpenStandaloneWorkspace?: (
    deviceId: string,
    workspacePath: string,
    label?: string
  ) => Promise<void> | void
  onSelectStandaloneDevice?: (deviceId: string | null) => void
  onGetRemoteDeviceStartupCommand?: () => Promise<DockerRemoteDeviceCommandResponse>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenSettings: (options?: OpenSettingsOptions) => void
  onLogout: () => void
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
const RUNTIME_ARCHIVE_UNDO_DELAY_MS = 2200
const MACOS_WINDOW_CONTROLS_SAFE_AREA_CLASS = 'left-[92px]'
const SIDEBAR_CHROME_TAB_BUTTON_CLASS =
  'group relative flex h-8 w-8 min-w-0 items-center justify-center rounded-lg px-0 text-center text-[13px] font-medium leading-none transition-colors'
const SIDEBAR_CHROME_TAB_TOOLTIP_CLASS =
  'pointer-events-none absolute left-1/2 top-[calc(100%+0.375rem)] z-popover -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-background px-2 py-1 text-xs font-medium leading-none text-text-primary opacity-0 shadow-[0_8px_20px_rgba(0,0,0,0.14)] transition-opacity group-hover:opacity-100'

function getAccountInitials(label: string): string {
  const normalizedLabel = label.trim()
  if (!normalizedLabel) return 'U'
  const [namePart] = normalizedLabel.split('@')
  const words = namePart.split(/[._\-\s]+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return namePart.slice(0, 2).toUpperCase()
}

function getSidebarAccountSummary(user: UserProfile | null, fallback: string) {
  const userName = user?.user_name?.trim()
  const email = user?.email?.trim()
  const label = userName || email || fallback
  const detail = email && email !== label ? email : fallback
  return {
    label,
    detail,
    initials: getAccountInitials(label),
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

  const device = devices.find(item => item.device_id === normalizedDeviceId)
  const deviceStatus = device?.status ?? 'unavailable'
  return {
    project: {
      key: `${normalizedDeviceId}:${normalizedWorkspacePath}`,
      name: getSidebarPathBasename(normalizedWorkspacePath),
      description: normalizedWorkspacePath,
      color: null,
    },
    deviceWorkspaces: [
      {
        id: null,
        projectId: null,
        deviceId: normalizedDeviceId,
        deviceName: device ? getStandaloneDeviceLabel(device) : normalizedDeviceId,
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
          <h2 id={`${testId}-title`} className="text-xl font-semibold tracking-normal">
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
      onClick={onClick}
      className={[
        'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium leading-[18px]',
        selected
          ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
          : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 text-[rgb(var(--color-sidebar-text-secondary))]" />
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

function readStoredStringSet(key: string): Set<string> {
  try {
    const value = window.localStorage.getItem(key)
    if (!value) return new Set()
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string' && item !== ''))
  } catch {
    return new Set()
  }
}

function writeStoredStringSet(key: string, values: Set<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values].sort()))
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
    <div className="group/section relative mb-2 flex h-8 items-center px-2.5">
      <button
        type="button"
        data-testid={toggleTestId}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md pr-8 text-left"
      >
        <span className="truncate text-[13px] font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]">
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

  const device = devices.find(item => item.device_id === deviceId)
  return {
    deviceId,
    device,
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
  const host = extractNetworkHost(value.trim())
  if (!host || isLoopbackNetworkHost(host)) return null
  return host
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

function isLoopbackNetworkHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function getRuntimeProjectDeviceState(
  runtimeProjectWork: RuntimeProjectWork | undefined,
  devices: DeviceInfo[]
): SidebarDeviceState | null {
  const workspace = runtimeProjectWork?.deviceWorkspaces[0]
  if (!workspace) return null
  const device = devices.find(item => item.device_id === workspace.deviceId)
  return {
    deviceId: workspace.deviceId,
    device,
    status: (device?.status ?? workspace.deviceStatus ?? 'unavailable') as SidebarDeviceStatus,
  }
}

function isRuntimeRemoteProject(runtimeProjectWork: RuntimeProjectWork | undefined): boolean {
  const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
  return (
    workspaces.length > 0 && workspaces.every(workspace => workspace.workspaceSource === 'remote')
  )
}

function shouldShowRuntimeProject(runtimeProjectWork: RuntimeProjectWork): boolean {
  const workspaces = runtimeProjectWork.deviceWorkspaces
  if (workspaces.length === 0) return true
  return workspaces.some(
    workspace => workspace.workspaceSource !== 'remote' || workspace.tasks.length > 0
  )
}

function shouldShowProjectDeviceStatus(
  deviceState: SidebarDeviceState | null,
  devices: DeviceInfo[]
): deviceState is SidebarDeviceState {
  if (!deviceState) return false
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

function getRuntimeTaskPinKey(workspace: RuntimeDeviceWorkspace, task: RuntimeTaskSummary): string {
  return getRuntimeNotificationKey(getRuntimeTaskAddress(workspace, task))
}

function prioritizePinnedRuntimeTaskItems(
  items: RuntimeSidebarTaskItem[],
  pinnedTaskKeys: ReadonlySet<string>
) {
  const pinnedItems: RuntimeSidebarTaskItem[] = []
  const unpinnedItems: RuntimeSidebarTaskItem[] = []
  for (const item of items) {
    if (pinnedTaskKeys.has(getRuntimeTaskPinKey(item.workspace, item.task))) {
      pinnedItems.push({ ...item, pinned: true })
    } else {
      unpinnedItems.push(item)
    }
  }
  return [...pinnedItems, ...unpinnedItems]
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
  onMenuOpenChange,
  onToggleGlobalImNotification,
  onOpenGlobalImNotificationSettings,
  onOpenSettings,
  onAddCloudDevice,
}: {
  devices: DeviceInfo[]
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onToggleGlobalImNotification?: () => Promise<void> | void
  onOpenGlobalImNotificationSettings?: () => Promise<void> | void
  onOpenSettings: () => void
  onAddCloudDevice: () => void
}) {
  const { t } = useTranslation('common')
  const cloud = useOptionalCloudConnection()
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
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

      {menuOpen && (
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
                'h-8 rounded-md px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-55',
                enabled
                  ? 'bg-muted text-text-primary hover:bg-muted/80'
                  : 'bg-text-primary text-background hover:bg-text-primary/90'
              )}
            >
              {primaryActionLabel}
            </button>
          </div>
        </div>
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
  const error = appUpdate?.error ?? null
  const busy = status === 'checking' || status === 'installing'
  const visibleForDebug = import.meta.env.DEV

  const showErrorTooltip = () => {
    if (!error || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setErrorTooltipPosition({
      left: Math.min(rect.right + 8, Math.max(8, window.innerWidth - 268)),
      top: Math.min(Math.max(8, rect.top + rect.height / 2), window.innerHeight - 8),
    })
  }

  if (!appUpdate || (!availableUpdate && !visibleForDebug)) return null

  const title = availableUpdate
    ? formatSidebarTemplate(
        t('workbench.app_update_install', {
          defaultValue: '更新到 {{version}}',
          version: availableUpdate.version,
        }),
        { version: availableUpdate.version }
      )
    : t('workbench.app_update_check', '检查更新')

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
        title={error ?? title}
        aria-label={error ?? title}
        className={cn(
          'group relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          error
            ? 'text-red-500 hover:bg-red-500/10'
            : 'text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]'
        )}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="sidebar-update-download-icon h-4 w-4" />
        )}
        {availableUpdate && (
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
        'ml-auto flex min-w-0 shrink-0 items-center gap-2 text-[13px] leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]',
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
  selected,
  unread,
  marked: controlledMarked,
  indentClassName = 'pl-12',
  imNotificationSettings,
  showDeviceMarker,
  onOpenRuntimeTask,
  onMarkRuntimeTaskRead,
  onToggleMark,
  onRenameRuntimeTask,
  onArchiveRuntimeTask,
  onToggleRuntimeTaskNotification,
}: {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  selected: boolean
  unread?: boolean
  marked?: boolean
  indentClassName?: string
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onMarkRuntimeTaskRead?: (address: RuntimeTaskAddress) => void
  onToggleMark?: (address: RuntimeTaskAddress) => void
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
  const [internalMarked, setInternalMarked] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archivePending, setArchivePending] = useState(false)
  const [archiveNoticeOpen, setArchiveNoticeOpen] = useState(false)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const archiveDelayRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const worktreeTask = isRuntimeWorktreeTask(task)
  const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
  const deviceColor = getRuntimeWorkspaceDeviceColor(workspace)
  const disabled = !workspace.available || !onOpenRuntimeTask
  const archiveDisabled =
    !workspace.available || !onArchiveRuntimeTask || archiving || archivePending
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  const notificationsSubscribed = isRuntimeTaskNotificationSubscribed(
    imNotificationSettings,
    taskAddress
  )
  const marked = controlledMarked ?? internalMarked
  const notificationsDisabled = !workspace.available || !onToggleRuntimeTaskNotification
  const handleOpen = () => {
    if (disabled) return
    onMarkRuntimeTaskRead?.(taskAddress)
    void onOpenRuntimeTask?.(taskAddress)
  }
  const handleToggleMark = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    if (controlledMarked === undefined) {
      setInternalMarked(value => !value)
      return
    }
    onToggleMark?.(taskAddress)
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
  const handleArchive = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
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
      <div
        data-testid={`runtime-local-task-row-${task.taskId}`}
        data-marked={marked ? 'true' : undefined}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={handleOpen}
        onDoubleClick={event => {
          event.stopPropagation()
          if (!disabled && onRenameRuntimeTask) {
            setRenameOpen(true)
          }
        }}
        onKeyDown={event => handleSidebarRowKeyDown(event, handleOpen)}
        className={cn(
          'group/task relative flex h-8 min-w-0 items-center rounded-md pr-2 text-[13px] leading-[18px]',
          indentClassName,
          disabled ? 'cursor-not-allowed opacity-55' : 'cursor-default',
          selected
            ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
            : marked
              ? 'bg-[rgb(var(--color-sidebar-marked))] text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-marked-hover))]'
              : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
        )}
      >
        <span title={task.title} className="min-w-0 flex-1 truncate">
          {task.title}
        </span>
        <span
          data-testid={`runtime-local-task-trailing-${task.taskId}`}
          className="relative ml-1 flex h-8 min-w-[32px] shrink-0 items-center justify-end transition-[width] group-hover/task:w-[72px]"
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
            {notificationsSubscribed &&
              renderNotificationButton(
                `runtime-local-task-notify-${task.taskId}`,
                `runtime-local-task-notify-icon-${task.taskId}`
              )}
            <span className="flex h-8 w-8 items-center justify-center">
              {task.running ? (
                <span
                  data-testid={`runtime-local-task-running-${task.taskId}`}
                  role="status"
                  title={t('workbench.runtime_task_running')}
                  aria-label={t('workbench.runtime_task_running')}
                  className="flex h-8 w-8 items-center justify-center"
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
            {renderNotificationButton(
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
              className={cn(
                'flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))]',
                marked && 'text-[rgb(var(--color-sidebar-marked-accent))]'
              )}
              title={
                marked
                  ? t('workbench.unmark_runtime_task', '取消标记')
                  : t('workbench.mark_runtime_task', '标记任务')
              }
              aria-label={
                marked
                  ? t('workbench.unmark_runtime_task', '取消标记')
                  : t('workbench.mark_runtime_task', '标记任务')
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
        onSubmit={title => onRenameRuntimeTask?.(taskAddress, title)}
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
  onSelectProject,
  devices,
  runtimeProjectWork,
  pinnedTaskKeysStorageKey,
  currentRuntimeTask,
  unreadTaskKeys,
  imNotificationSettings,
  showDeviceMarker,
  onStartNewProjectChat,
  onRemoveProject,
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
  onSelectProject?: (projectId: number) => void
  devices: DeviceInfo[]
  runtimeProjectWork?: RuntimeProjectWork
  pinnedTaskKeysStorageKey: string
  currentRuntimeTask?: RuntimeTaskAddress | null
  unreadTaskKeys: ReadonlySet<string>
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  onStartNewProjectChat: (projectId: number) => void
  onRemoveProject: (projectId: number) => Promise<void>
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
  const runtimeTaskItems = useMemo(
    () => getRuntimeSidebarTaskItems(runtimeWorkspaces ?? []),
    [runtimeWorkspaces]
  )
  const [runtimeTaskVisibleLimit, setRuntimeTaskVisibleLimit] = useState(
    RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
  )
  const [projectArchiving, setProjectArchiving] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [forceArchiveConfirmOpen, setForceArchiveConfirmOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [removingProject, setRemovingProject] = useState(false)
  const pinnedTaskKeysStorageRef = useRef(pinnedTaskKeysStorageKey)
  const [pinnedRuntimeTaskKeys, setPinnedRuntimeTaskKeys] = useState<Set<string>>(() =>
    readStoredStringSet(pinnedTaskKeysStorageKey)
  )
  const prioritizedRuntimeTaskItems = useMemo(
    () => prioritizePinnedRuntimeTaskItems(runtimeTaskItems, pinnedRuntimeTaskKeys),
    [pinnedRuntimeTaskKeys, runtimeTaskItems]
  )
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
  const projectDeviceState =
    getRuntimeProjectDeviceState(runtimeProjectWork, devices) ??
    getSidebarDeviceState(getProjectDeviceId(project), devices)
  const showProjectDeviceStatus = shouldShowProjectDeviceStatus(projectDeviceState, devices)
  const canStartProjectChat = isSidebarDeviceOnline(projectDeviceState)
  const canArchiveProjectConversations =
    Boolean(runtimeProjectWork?.project.key) &&
    runtimeTaskItems.length > 0 &&
    Boolean(onArchiveProjectConversations) &&
    !projectArchiving
  const newProjectChatTitle =
    projectDeviceState && !canStartProjectChat
      ? getDeviceUnavailableActionTitle(t, projectDeviceState)
      : t('workbench.new_project_chat', '新建项目对话')
  const archiveConversationCount = runtimeTaskItems.length
  const archiveProjectName = runtimeProjectWork?.project.name ?? project.name
  const toggleRuntimeTaskPin = (address: RuntimeTaskAddress) => {
    const taskKey = getRuntimeNotificationKey(address)
    setPinnedRuntimeTaskKeys(currentKeys => {
      const nextKeys = new Set(currentKeys)
      if (nextKeys.has(taskKey)) {
        nextKeys.delete(taskKey)
      } else {
        nextKeys.add(taskKey)
      }
      return nextKeys
    })
  }
  useEffect(() => {
    if (pinnedTaskKeysStorageRef.current !== pinnedTaskKeysStorageKey) return
    writeStoredStringSet(pinnedTaskKeysStorageKey, pinnedRuntimeTaskKeys)
  }, [pinnedRuntimeTaskKeys, pinnedTaskKeysStorageKey])
  useEffect(() => {
    if (pinnedTaskKeysStorageRef.current === pinnedTaskKeysStorageKey) return
    pinnedTaskKeysStorageRef.current = pinnedTaskKeysStorageKey
    setPinnedRuntimeTaskKeys(readStoredStringSet(pinnedTaskKeysStorageKey))
  }, [pinnedTaskKeysStorageKey])
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
    } finally {
      setRemovingProject(false)
    }
  }

  return (
    <div data-testid="project-item" className="space-y-0.5">
      <div
        data-testid={`project-row-${project.id}`}
        className="group/project relative flex h-8 min-w-0 items-center gap-1 rounded-md pl-2.5 pr-1 text-[13px] leading-[18px] text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
      >
        <button
          type="button"
          data-testid="project-item-button"
          onClick={() => {
            onToggleProject(project.id)
            onSelectProject?.(project.id)
          }}
          aria-expanded={expanded}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 text-left',
            showProjectDeviceStatus ? 'pr-[132px]' : 'pr-[58px]'
          )}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <ProjectFolderIcon
              project={project}
              remote={isRuntimeRemoteProject(runtimeProjectWork)}
              className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-secondary))]"
            />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              data-testid={`project-title-${project.id}`}
              className="min-w-0 truncate"
              title={project.name}
            >
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
            items={[
              {
                label: t('workbench.rename_project', '重命名项目'),
                icon: Edit3,
                testId: `rename-project-${project.id}`,
                onSelect: () => onRenameProject(project),
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
            triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
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
            className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-sidebar-text-secondary))]"
            title={newProjectChatTitle}
            aria-label={newProjectChatTitle}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      </div>
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
                {visibleRuntimeTaskItems.map(({ workspace, task }) => (
                  <RuntimeTaskRow
                    key={`${workspace.deviceId}:${task.workspacePath}:${task.taskId}`}
                    workspace={workspace}
                    task={task}
                    selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                    unread={unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))}
                    marked={pinnedRuntimeTaskKeys.has(getRuntimeTaskPinKey(workspace, task))}
                    indentClassName="pl-9"
                    imNotificationSettings={imNotificationSettings}
                    showDeviceMarker={showDeviceMarker}
                    onOpenRuntimeTask={onOpenRuntimeTask}
                    onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                    onToggleMark={toggleRuntimeTaskPin}
                    onRenameRuntimeTask={onRenameRuntimeTask}
                    onArchiveRuntimeTask={onArchiveRuntimeTask}
                    onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                  />
                ))}
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
                        className="flex h-8 items-center rounded-md px-2 text-left text-[13px] font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
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
                        className="flex h-8 items-center rounded-md px-2 text-left text-[13px] font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
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
  onOpenSearch,
  onSelectProject,
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
  onRefreshDevices,
  onOpenStandaloneWorkspace,
  onSelectStandaloneDevice,
  onGetRemoteDeviceStartupCommand,
  onUpdateProjectName,
  onRemoveProject,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenSettings,
  onLogout,
  collapsed = false,
  containerTestId = 'desktop-sidebar',
  hideResizeHandle = false,
  onResizeCollapse,
  onResizeStateChange,
  onPointerEnter,
  onPointerLeave,
  onToggleSidebar,
  onOpenWorkbench,
  onOpenApps,
}: DesktopSidebarProps) {
  useSidebarRelativeTimeRefresh()
  const { t } = useTranslation('common')
  const { sidebarWidth, resizing, handleResizeStart } = useResizableSidebar({
    onCollapse: onResizeCollapse,
    onResizeStateChange,
  })
  const showCloudConnectionEntry = isCloudConnectionUiAvailable()
  const usesOverlayTitlebar = isTauriRuntime()
  const sidebarAccount = getSidebarAccountSummary(user, t('workbench.account_fallback', '当前账号'))
  const workbenchAppLabel = t('workbench.app_wework')
  const appsAppLabel = t('workbench.apps')

  const storageScope = getDesktopSidebarStorageScope(user)
  const projectsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'projectsExpanded')
  const chatsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'chatsExpanded')
  const expandedProjectIdsStorageKey = getDesktopSidebarStorageKey(
    storageScope,
    'expandedProjectIds'
  )
  const storageScopeRef = useRef(storageScope)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
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
  const visibleUnreadRuntimeTaskKeys = unreadRuntimeTaskKeys ?? new Set<string>()
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
  const filteredRuntimeProjects = useMemo(() => {
    const items = (runtimeWork?.projects ?? []).filter(shouldShowRuntimeProject)
    return standaloneProjectWork ? [standaloneProjectWork, ...items] : items
  }, [runtimeWork?.projects, standaloneProjectWork])
  const sidebarProjects = useMemo(() => {
    if (runtimeWork || standaloneProjectWork) {
      return filteredRuntimeProjects.map(runtimeProjectToProject)
    }
    return projects
  }, [filteredRuntimeProjects, projects, runtimeWork, standaloneProjectWork])
  const visibleExpandedProjectIds = useMemo(
    () => pruneProjectIdSet(expandedProjectIds, sidebarProjects),
    [expandedProjectIds, sidebarProjects]
  )
  const runtimeWorkByProjectId = useMemo(() => {
    return new Map(filteredRuntimeProjects.map(item => [runtimeProjectUiId(item.project), item]))
  }, [filteredRuntimeProjects])
  const chatWorkspaces = useMemo(() => runtimeWork?.chats ?? [], [runtimeWork?.chats])
  const chatTaskItems = useMemo(
    () => getRuntimeChatSidebarTaskItems(chatWorkspaces),
    [chatWorkspaces]
  )
  const projectSectionArchiveItems = useMemo(() => {
    return filteredRuntimeProjects
      .map(projectWork => ({
        key: projectWork.project.key,
        count: getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).length,
      }))
      .filter(item => item.count > 0)
  }, [filteredRuntimeProjects])
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
      const projectWork = filteredRuntimeProjects.find(item =>
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

    const projectWork = filteredRuntimeProjects.find(item =>
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
  }, [currentRuntimeTask, filteredRuntimeProjects, standaloneDeviceId, standaloneWorkspacePath])
  const selectedRuntimeProjectId = selectedRuntimeProject?.id ?? null
  const selectedRuntimeProjectAutoExpandKey = selectedRuntimeProject?.autoExpandKey ?? null
  const selectedRuntimeChatVisible = useMemo(() => {
    if (!currentRuntimeTask) return false
    return chatTaskItems.some(({ workspace, task }) =>
      isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
    )
  }, [currentRuntimeTask, chatTaskItems])
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
      aria-hidden={collapsed}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        'relative z-popover shrink-0 overflow-visible bg-transparent transition-[width] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none will-change-[width]',
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
              <button
                type="button"
                data-testid="chrome-tab-wework"
                onClick={onOpenWorkbench}
                title={workbenchAppLabel}
                aria-label={workbenchAppLabel}
                className={cn(
                  SIDEBAR_CHROME_TAB_BUTTON_CLASS,
                  'bg-black/[0.045] text-text-primary'
                )}
              >
                <Globe2 aria-hidden="true" className="h-4 w-4 shrink-0 stroke-[1.8]" />
                <span className="sr-only">{workbenchAppLabel}</span>
                <span className={SIDEBAR_CHROME_TAB_TOOLTIP_CLASS}>{workbenchAppLabel}</span>
              </button>
              <button
                type="button"
                data-testid="chrome-tab-apps"
                onClick={onOpenApps}
                title={appsAppLabel}
                aria-label={appsAppLabel}
                className={cn(
                  SIDEBAR_CHROME_TAB_BUTTON_CLASS,
                  'text-text-secondary hover:bg-black/[0.04]'
                )}
              >
                <Grid3X3 aria-hidden="true" className="h-4 w-4 shrink-0 stroke-[1.8]" />
                <span className="sr-only">{appsAppLabel}</span>
                <span className={SIDEBAR_CHROME_TAB_TOOLTIP_CLASS}>{appsAppLabel}</span>
              </button>
            </div>
          )}
          <nav className="space-y-0.5">
            <SidebarButton
              icon={Plus}
              label={t('workbench.new_chat', '新对话')}
              testId="new-chat-button"
              onClick={onNewChat}
            />
            {onOpenSearch && (
              <SidebarButton
                icon={Search}
                label={t('workbench.search')}
                testId="runtime-search-button"
                onClick={onOpenSearch}
              />
            )}
            {showCloudConnectionEntry && (
              <CloudConnectionSidebarButton
                devices={devices}
                cloudWorkStatus={cloudWorkStatus}
                onOpenSettings={() => onOpenSettings({ settingsPage: 'connections' })}
                onSelectCloudDevice={deviceId => onSelectStandaloneDevice?.(deviceId)}
                onAddDevice={() => {
                  setStandaloneRemoteDialogIntent('add-device')
                  setStandaloneWorkspaceDialogMode('remote')
                }}
              />
            )}
            {SHOW_PLUGINS_NAVIGATION && (
              <SidebarButton
                icon={Sparkles}
                label={t('workbench.plugins', '插件')}
                testId="plugins-button"
                selected={activeItem === 'plugins'}
                onClick={onOpenPlugins}
              />
            )}
          </nav>

          <div
            data-testid="sidebar-worklists-scroll"
            className="scrollbar-none my-3 min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
          >
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
                    className="fixed z-modal rounded-xl border border-border bg-surface p-1.5 text-[13px] text-text-primary shadow-lg"
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
                        setBlankProjectDialogOpen(true)
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
                        setStandaloneWorkspaceDialogMode('existing')
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
                        setStandaloneRemoteDialogIntent('project')
                        setStandaloneWorkspaceDialogMode('remote')
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
                <div className="space-y-1">
                  {sidebarProjects.map(project => (
                    <ProjectItem
                      key={project.id}
                      project={project}
                      expanded={displayedExpandedProjectIds.has(project.id)}
                      devices={devices}
                      runtimeProjectWork={runtimeWorkByProjectId.get(project.id)}
                      pinnedTaskKeysStorageKey={getDesktopSidebarStorageKey(
                        storageScope,
                        `pinnedRuntimeTaskKeys.${project.id}`
                      )}
                      currentRuntimeTask={currentRuntimeTask}
                      unreadTaskKeys={visibleUnreadRuntimeTaskKeys}
                      imNotificationSettings={imNotificationSettings}
                      showDeviceMarker={false}
                      onToggleProject={handleToggleProject}
                      onSelectProject={onSelectProject}
                      onStartNewProjectChat={onStartNewProjectChat}
                      onRemoveProject={onRemoveProject}
                      onRenameProject={setRenamingProject}
                      onOpenRuntimeTask={onOpenRuntimeTask}
                      onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                      onRenameRuntimeTask={onRenameRuntimeTask}
                      onArchiveRuntimeTask={onArchiveRuntimeTask}
                      onArchiveProjectConversations={onArchiveProjectConversations}
                      onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                    />
                  ))}
                </div>
              )}
            </section>

            <section data-testid="runtime-chat-section" className="mt-8">
              <SidebarSectionHeader
                title={t('workbench.chats', '对话')}
                expanded={displayedChatsExpanded}
                hasContent={chatTaskItems.length > 0}
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
                    aria-label={t('workbench.new_chat', '新对话')}
                    data-testid="runtime-chat-section-new-chat-button"
                    onClick={event => {
                      event.stopPropagation()
                      onNewChat()
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </button>
                </div>
              </SidebarSectionHeader>
              {displayedChatsExpanded && (
                <div className="space-y-0.5 pb-2">
                  {chatTaskItems.length === 0 ? (
                    <div
                      data-testid="runtime-chat-empty"
                      className="ml-2 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
                    >
                      {t('workbench.no_chats', '暂无会话')}
                    </div>
                  ) : (
                    chatTaskItems.map(({ workspace, task }) => (
                      <RuntimeTaskRow
                        key={`${workspace.deviceId}:${task.workspacePath}:${task.taskId}`}
                        workspace={workspace}
                        task={task}
                        selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                        unread={visibleUnreadRuntimeTaskKeys.has(
                          getRuntimeTaskReminderItemKey(workspace, task)
                        )}
                        indentClassName="pl-2.5"
                        imNotificationSettings={imNotificationSettings}
                        showDeviceMarker={false}
                        onOpenRuntimeTask={onOpenRuntimeTask}
                        onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                        onRenameRuntimeTask={onRenameRuntimeTask}
                        onArchiveRuntimeTask={onArchiveRuntimeTask}
                        onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                      />
                    ))
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
                className="flex h-[60px] min-w-0 flex-1 items-center gap-3 rounded-[10px] py-2 pl-1.5 pr-10 text-left text-[rgb(var(--color-sidebar-text-primary))] transition-[padding] group-hover/account:pr-[72px] group-focus-within/account:pr-[72px]"
                title={t('workbench.settings', '设置')}
                aria-label={t('workbench.settings', '设置')}
                aria-expanded={settingsMenuOpen}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[12px] font-semibold leading-none text-primary">
                  {sidebarAccount.initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold leading-[18px]">
                    {sidebarAccount.label}
                  </span>
                  <span className="block truncate text-[12px] font-medium leading-4 text-[rgb(var(--color-sidebar-text-secondary))]">
                    {sidebarAccount.detail}
                  </span>
                </span>
              </button>
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                <div className="max-w-0 translate-x-1 overflow-hidden opacity-0 transition-[max-width,opacity,transform] duration-150 group-hover/account:max-w-8 group-hover/account:translate-x-0 group-hover/account:opacity-100 group-focus-within/account:max-w-8 group-focus-within/account:translate-x-0 group-focus-within/account:opacity-100">
                  <SidebarAppUpdateButton
                    onBeforeInstall={() => {
                      setSettingsMenuOpen(false)
                      setImNotificationMenuOpen(false)
                    }}
                  />
                </div>
                <GlobalImNotificationBell
                  devices={devices}
                  imNotificationSettings={imNotificationSettings}
                  menuOpen={imNotificationMenuOpen}
                  onMenuOpenChange={open => {
                    if (open) setSettingsMenuOpen(false)
                    setImNotificationMenuOpen(open)
                  }}
                  onToggleGlobalImNotification={onToggleGlobalImNotification}
                  onOpenGlobalImNotificationSettings={onOpenGlobalImNotificationSettings}
                  onOpenSettings={() => onOpenSettings()}
                  onAddCloudDevice={() => {
                    setStandaloneRemoteDialogIntent('add-device')
                    setStandaloneWorkspaceDialogMode('remote')
                  }}
                />
              </div>
              {settingsMenuOpen && (
                <DesktopSettingsMenu
                  user={user}
                  onOpenSettings={() => {
                    setSettingsMenuOpen(false)
                    onOpenSettings()
                  }}
                  onLogout={onLogout}
                />
              )}
            </div>
          </div>

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
