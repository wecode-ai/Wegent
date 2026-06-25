import {
  Archive,
  Bell,
  ChevronRight,
  Edit3,
  FolderPlus,
  Globe2,
  GitCompareArrows,
  Loader2,
  MessageSquarePlus,
  Plus,
  RotateCw,
  Settings,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import {
  StandaloneBlankProjectDialog,
  StandaloneFolderProjectDialog,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
import type {
  DeviceInfo,
  LocalTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectWork,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'
import { DesktopTopBar } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import {
  getRuntimeChatSidebarTaskItems,
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  getRuntimeTaskWorkspaceTitle,
  getRuntimeSidebarTaskItems,
  getVisibleRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  isRuntimeTaskSelected,
  isRuntimeWorktreeTask,
} from './runtimeTaskSidebarHelpers'
import { useResizableSidebar } from './useResizableSidebar'

interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentRuntimeTask?: RuntimeTaskAddress | null
  standaloneDeviceId?: string | null
  standaloneWorkspacePath?: string | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  preferredDeviceId?: string | null
  activeItem?: 'chat' | 'plugins' | 'automation'
  onCollapse: () => void
  onNewChat: () => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onRenameRuntimeLocalTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveProjectConversations?: (runtimeProjectKey: string) => Promise<void> | void
  onArchiveProjectsConversations?: (runtimeProjectKeys: string[]) => Promise<void> | void
  onArchiveChatConversations?: (addresses: RuntimeTaskAddress[]) => Promise<void> | void
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
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenSettings: (options?: { autoOpenAddCloudDeviceDialog?: boolean }) => void
  onRefreshWorkLists?: () => Promise<void>
  onLogout: () => void
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
        localTasks: [],
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
            className="h-9 min-w-[76px] rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={`${testId}-confirm-button`}
            onClick={() => void onConfirm()}
            disabled={submitting}
            className="inline-flex h-9 min-w-[96px] items-center justify-center gap-2 rounded-lg bg-red-500/15 px-4 text-sm font-semibold text-red-500 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60"
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
    <div className="group/section mb-2 flex h-7 items-center justify-between px-2.5">
      <button
        type="button"
        data-testid={toggleTestId}
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left"
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
      <div className="flex items-center opacity-0 transition-opacity group-hover/section:opacity-100 focus-within:opacity-100">
        {children}
      </div>
    </div>
  )
}

function formatRelativeSidebarTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const elapsedMs = Math.max(0, Date.now() - date.getTime())
  const minutes = Math.floor(elapsedMs / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  return `${Math.floor(days / 7)}w`
}

type SidebarDeviceStatus = DeviceInfo['status'] | 'unavailable'

interface SidebarDeviceState {
  deviceId: string
  device?: DeviceInfo
  status: SidebarDeviceStatus
}

function runtimeProjectToProject(projectWork: RuntimeProjectWork): ProjectWithTasks {
  return {
    id: runtimeProjectUiId(projectWork.project),
    name: projectWork.project.name,
    description: projectWork.project.description,
    color: projectWork.project.color,
    tasks: [],
  }
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
  return Boolean(
    runtimeProjectWork?.deviceWorkspaces.some(workspace => workspace.workspaceSource === 'remote')
  )
}

function shouldShowProjectDeviceStatus(
  deviceState: SidebarDeviceState | null,
  devices: DeviceInfo[]
): deviceState is SidebarDeviceState {
  if (!deviceState || devices.length <= 1) return false
  return deviceState.device?.device_type !== 'local'
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
  return `${address.deviceId}\0${address.localTaskId}`
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
  settings: RuntimeIMNotificationSettingsResponse | null | undefined
): string {
  const target = getImNotificationSessionLabel(settings)
  if (settings?.global.enabled) {
    return target
      ? `${t('workbench.global_im_notifications_on', '全局 IM 通知已开启')} · ${target}`
      : t('workbench.global_im_notifications_on', '全局 IM 通知已开启')
  }
  return target
    ? `${t('workbench.global_im_notifications_off', '全局 IM 通知已关闭')} · ${target}`
    : t('workbench.global_im_notifications_off', '全局 IM 通知已关闭')
}

function formatSidebarTemplate(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
    template
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
  const label = getDeviceNetworkLabel(deviceState.device) || deviceState.deviceId
  const online = deviceState.status === 'online'

  return (
    <span
      data-testid={testId}
      title={label}
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

function RuntimeLocalTaskRow({
  workspace,
  task,
  selected,
  indentClassName = 'pl-12',
  imNotificationSettings,
  showDeviceMarker,
  onOpenRuntimeLocalTask,
  onRenameRuntimeLocalTask,
  onArchiveRuntimeLocalTask,
  onToggleRuntimeTaskNotification,
}: {
  workspace: RuntimeDeviceWorkspace
  task: LocalTaskSummary
  selected: boolean
  indentClassName?: string
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onRenameRuntimeLocalTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const [archiving, setArchiving] = useState(false)
  const [archivePending, setArchivePending] = useState(false)
  const [archiveNoticeOpen, setArchiveNoticeOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const archiveDelayRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const worktreeTask = isRuntimeWorktreeTask(task)
  const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
  const deviceColor = getRuntimeWorkspaceDeviceColor(workspace)
  const disabled = !workspace.available || !onOpenRuntimeLocalTask
  const archiveDisabled =
    !workspace.available || !onArchiveRuntimeLocalTask || archiving || archivePending
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  const notificationsSubscribed = isRuntimeTaskNotificationSubscribed(
    imNotificationSettings,
    taskAddress
  )
  const notificationsDisabled = !workspace.available || !onToggleRuntimeTaskNotification
  const handleOpen = () => {
    if (disabled) return
    void onOpenRuntimeLocalTask?.(taskAddress)
  }
  useEffect(() => {
    return () => {
      if (archiveDelayRef.current !== null) {
        window.clearTimeout(archiveDelayRef.current)
      }
    }
  }, [])
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
      setArchiving(true)
      void Promise.resolve(onArchiveRuntimeLocalTask?.(taskAddress)).finally(() => {
        setArchiving(false)
      })
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
  const handleToggleNotification = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    if (notificationsDisabled) return
    void onToggleRuntimeTaskNotification?.(taskAddress, notificationsSubscribed)
  }
  const notificationActionLabel = notificationsSubscribed
    ? t('workbench.unsubscribe_runtime_task_notifications', '取消任务通知')
    : t('workbench.subscribe_runtime_task_notifications', '订阅任务通知')
  const renderNotificationButton = (testId: string, iconTestId: string) => (
    <button
      type="button"
      data-testid={testId}
      disabled={notificationsDisabled}
      aria-pressed={notificationsSubscribed}
      onClick={handleToggleNotification}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45',
        notificationsSubscribed && 'text-primary'
      )}
      title={notificationActionLabel}
      aria-label={notificationActionLabel}
    >
      <Bell
        data-testid={iconTestId}
        className={cn('h-4 w-4', notificationsSubscribed && 'fill-current')}
      />
    </button>
  )

  return (
    <>
      <div
        data-testid={`runtime-local-task-row-${task.localTaskId}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={handleOpen}
        onDoubleClick={event => {
          event.stopPropagation()
          if (!disabled && onRenameRuntimeLocalTask) {
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
            : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
        )}
      >
        <span title={task.title} className="min-w-0 flex-1 truncate group-hover/task:pr-14">
          {task.title}
        </span>
        <span
          data-testid={`runtime-local-task-trailing-${task.localTaskId}`}
          className="relative ml-1 flex h-7 shrink-0 items-center justify-end"
        >
          <span
            data-testid={`runtime-local-task-time-${task.localTaskId}`}
            className={SIDEBAR_ROW_METADATA_CLASS}
          >
            {worktreeTask && (
              <GitCompareArrows
                data-testid={`runtime-local-task-worktree-icon-${task.localTaskId}`}
                className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]"
                aria-label="Worktree"
              />
            )}
            {notificationsSubscribed &&
              renderNotificationButton(
                `runtime-local-task-notify-${task.localTaskId}`,
                `runtime-local-task-notify-icon-${task.localTaskId}`
              )}
            <span className="flex h-7 w-7 items-center justify-center">
              {task.running ? (
                <span
                  data-testid={`runtime-local-task-running-${task.localTaskId}`}
                  role="status"
                  title={t('workbench.runtime_task_running')}
                  aria-label={t('workbench.runtime_task_running')}
                  className="flex h-7 w-7 items-center justify-center"
                >
                  <Loader2 className={SIDEBAR_RUNNING_SPINNER_CLASS} aria-hidden="true" />
                </span>
              ) : (
                formatRelativeSidebarTime(getRuntimeTaskTime(task))
              )}
            </span>
            {showDeviceMarker && (
              <span
                data-testid={`runtime-local-task-device-marker-${task.localTaskId}`}
                title={workspaceTitle}
                aria-label={workspaceTitle}
                className="h-3.5 w-0.5 shrink-0 rounded-full"
                style={{ backgroundColor: deviceColor }}
              />
            )}
          </span>
          <span
            data-testid={`runtime-local-task-hover-actions-${task.localTaskId}`}
            className="pointer-events-none invisible absolute right-0 top-1/2 flex w-[52px] -translate-y-1/2 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:visible group-hover/task:opacity-100"
          >
            {renderNotificationButton(
              notificationsSubscribed
                ? `runtime-local-task-notify-hover-${task.localTaskId}`
                : `runtime-local-task-notify-${task.localTaskId}`,
              notificationsSubscribed
                ? `runtime-local-task-notify-hover-icon-${task.localTaskId}`
                : `runtime-local-task-notify-icon-${task.localTaskId}`
            )}
            <button
              type="button"
              data-testid={`runtime-local-task-archive-${task.localTaskId}`}
              disabled={archiveDisabled}
              onClick={handleArchive}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
              title={t('workbench.archive_runtime_task', '归档')}
              aria-label={t('workbench.archive_runtime_task', '归档')}
            >
              {archiving ? (
                <RotateCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive
                  data-testid={`runtime-local-task-archive-icon-${task.localTaskId}`}
                  className="h-4 w-4"
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
        inputTestId={`rename-runtime-local-task-input-${task.localTaskId}`}
        confirmTestId={`confirm-rename-runtime-local-task-${task.localTaskId}`}
        onClose={() => setRenameOpen(false)}
        onSubmit={title => onRenameRuntimeLocalTask?.(taskAddress, title)}
      />
      {archiveNoticeOpen &&
        createPortal(
          <div
            data-testid={`runtime-local-task-archive-toast-${task.localTaskId}`}
            role="status"
            aria-live="polite"
            className="fixed left-1/2 top-5 z-[200] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-text-primary shadow-lg"
          >
            <button
              type="button"
              data-testid={`runtime-local-task-archive-undo-${task.localTaskId}`}
              onClick={handleUndoArchive}
              className="font-medium text-primary hover:underline"
            >
              {t('workbench.archive_runtime_task_undo', '撤销')}
            </button>
            <span>{t('workbench.archive_runtime_task_pending', '，稍后将归档')}</span>
            <button
              type="button"
              data-testid={`runtime-local-task-archive-toast-close-${task.localTaskId}`}
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
  imNotificationSettings,
  showDeviceMarker,
  onStartNewProjectChat,
  onRemoveProject,
  onRenameProject,
  onOpenRuntimeLocalTask,
  onRenameRuntimeLocalTask,
  onArchiveRuntimeLocalTask,
  onArchiveProjectConversations,
  onToggleRuntimeTaskNotification,
}: {
  project: ProjectWithTasks
  expanded: boolean
  onToggleProject: (projectId: number) => void
  devices: DeviceInfo[]
  runtimeProjectWork?: RuntimeProjectWork
  currentRuntimeTask?: RuntimeTaskAddress | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  onStartNewProjectChat: (projectId: number) => void
  onRemoveProject: (projectId: number) => Promise<void>
  onRenameProject: (project: ProjectWithTasks) => void
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onRenameRuntimeLocalTask?: (address: RuntimeTaskAddress, title: string) => Promise<void> | void
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveProjectConversations?: (runtimeProjectKey: string) => Promise<void> | void
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
  const [runtimeTasksExpanded, setRuntimeTasksExpanded] = useState(false)
  const [projectArchiving, setProjectArchiving] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const visibleRuntimeTaskItems = useMemo(
    () => getVisibleRuntimeSidebarTaskItems(runtimeTaskItems, runtimeTasksExpanded),
    [runtimeTaskItems, runtimeTasksExpanded]
  )
  const hasHiddenRuntimeTasks = hasHiddenRuntimeSidebarTaskItems(runtimeTaskItems)
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
  const closeArchiveConfirm = () => {
    if (!projectArchiving) {
      setArchiveConfirmOpen(false)
    }
  }
  const confirmArchiveProjectConversations = async () => {
    const runtimeProjectKey = runtimeProjectWork?.project.key
    if (!runtimeProjectKey || !onArchiveProjectConversations) return
    setProjectArchiving(true)
    try {
      await onArchiveProjectConversations(runtimeProjectKey)
      setArchiveConfirmOpen(false)
    } finally {
      setProjectArchiving(false)
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
          }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2.5 pr-1 text-left"
        >
          <ProjectFolderIcon
            project={project}
            remote={isRuntimeRemoteProject(runtimeProjectWork)}
            className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-secondary))]"
          />
          <span className="min-w-0 flex-1 truncate" title={project.name}>
            {project.name}
          </span>
          {showProjectDeviceStatus && (
            <ProjectDeviceInlineStatus
              deviceState={projectDeviceState}
              testId={`project-device-status-${project.id}`}
              className="ml-auto justify-end text-right group-hover/project:invisible group-focus-within/project:invisible"
            />
          )}
        </button>
        <div className="absolute right-1 invisible flex shrink-0 items-center opacity-0 transition-opacity group-hover/project:visible group-hover/project:opacity-100 focus-within:visible focus-within:opacity-100">
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
                onSelect: () => {
                  if (window.confirm(t('workbench.remove_project_confirm', '确定移除该项目吗？'))) {
                    void onRemoveProject(project.id)
                  }
                },
              },
            ]}
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
            className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-sidebar-text-secondary))]"
            title={newProjectChatTitle}
            aria-label={newProjectChatTitle}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>
      </div>
      {expanded && (
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
                <RuntimeLocalTaskRow
                  key={`${workspace.deviceId}:${task.workspacePath}:${task.localTaskId}`}
                  workspace={workspace}
                  task={task}
                  selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                  indentClassName="pl-9"
                  imNotificationSettings={imNotificationSettings}
                  showDeviceMarker={showDeviceMarker}
                  onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
                  onRenameRuntimeLocalTask={onRenameRuntimeLocalTask}
                  onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
                  onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                />
              ))}
              {hasHiddenRuntimeTasks && (
                <button
                  type="button"
                  data-testid={
                    runtimeTasksExpanded
                      ? `project-runtime-tasks-collapse-${project.id}`
                      : `project-runtime-tasks-expand-${project.id}`
                  }
                  onClick={() => setRuntimeTasksExpanded(expanded => !expanded)}
                  className="ml-9 flex h-8 items-center rounded-md px-2 text-left text-[13px] font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
                >
                  {runtimeTasksExpanded
                    ? t('workbench.collapse_display', '折叠显示')
                    : t('workbench.expand_display', '展开显示')}
                </button>
              )}
            </>
          )}
        </div>
      )}
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
    </div>
  )
}

export function DesktopSidebar({
  user,
  projects,
  devices,
  runtimeWork,
  currentRuntimeTask,
  standaloneDeviceId,
  standaloneWorkspacePath,
  imNotificationSettings,
  preferredDeviceId,
  activeItem = 'chat',
  onCollapse,
  onNewChat,
  onStartNewProjectChat,
  onOpenRuntimeLocalTask,
  onRenameRuntimeLocalTask,
  onArchiveRuntimeLocalTask,
  onArchiveProjectConversations,
  onArchiveProjectsConversations,
  onArchiveChatConversations,
  onToggleRuntimeTaskNotification,
  onToggleGlobalImNotification,
  onOpenGlobalImNotificationSettings,
  onOpenPlugins,
  onRefreshDevices,
  onOpenStandaloneWorkspace,
  onUpdateProjectName,
  onRemoveProject,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenSettings,
  onRefreshWorkLists,
  onLogout,
}: DesktopSidebarProps) {
  const { t } = useTranslation('common')
  const { sidebarWidth, handleResizeStart } = useResizableSidebar()

  const storageScope = getDesktopSidebarStorageScope(user)
  const projectsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'projectsExpanded')
  const chatsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'chatsExpanded')
  const expandedProjectIdsStorageKey = getDesktopSidebarStorageKey(
    storageScope,
    'expandedProjectIds'
  )
  const storageScopeRef = useRef(storageScope)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [archiveSectionMode, setArchiveSectionMode] = useState<'projects' | 'chats' | null>(null)
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
    const items = runtimeWork?.projects ?? []
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
  const selectedRuntimeProjectId = useMemo(() => {
    if (!currentRuntimeTask) return null
    const projectWork = runtimeWork?.projects.find(item =>
      item.deviceWorkspaces.some(workspace =>
        workspace.localTasks.some(task =>
          isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
        )
      )
    )
    return projectWork?.project.id ?? null
  }, [currentRuntimeTask, runtimeWork?.projects])
  const selectedRuntimeChatVisible = useMemo(() => {
    if (!currentRuntimeTask) return false
    return chatTaskItems.some(({ workspace, task }) =>
      isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
    )
  }, [currentRuntimeTask, chatTaskItems])
  const displayedProjectsExpanded = projectsExpanded || selectedRuntimeProjectId !== null
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
  const confirmArchiveSectionConversations = async () => {
    if (archiveSectionMode === 'projects') {
      if (!onArchiveProjectsConversations || projectSectionArchiveKeys.length === 0) return
      setIsArchivingProjectSection(true)
      try {
        await onArchiveProjectsConversations(projectSectionArchiveKeys)
        setArchiveSectionMode(null)
      } finally {
        setIsArchivingProjectSection(false)
      }
      return
    }

    if (archiveSectionMode === 'chats') {
      if (!onArchiveChatConversations || chatSectionArchiveAddresses.length === 0) return
      setIsArchivingChatSection(true)
      try {
        await onArchiveChatConversations(chatSectionArchiveAddresses)
        setArchiveSectionMode(null)
      } finally {
        setIsArchivingChatSection(false)
      }
    }
  }
  const displayedExpandedProjectIds = useMemo(() => {
    if (selectedRuntimeProjectId === null) return visibleExpandedProjectIds
    if (visibleExpandedProjectIds.has(selectedRuntimeProjectId)) return visibleExpandedProjectIds
    return new Set([...visibleExpandedProjectIds, selectedRuntimeProjectId])
  }, [selectedRuntimeProjectId, visibleExpandedProjectIds])

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
    if (!settingsMenuOpen) {
      return
    }

    const handleOutsidePointer = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
      if (!settingsMenuRef.current?.contains(event.target as Node)) {
        setSettingsMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointer)
    document.addEventListener('mousedown', handleOutsidePointer)

    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      document.removeEventListener('mousedown', handleOutsidePointer)
    }
  }, [settingsMenuOpen])

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
      `[data-testid="runtime-local-task-row-${currentRuntimeTask.localTaskId}"]`
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
      className="relative flex shrink-0 flex-col bg-transparent px-1.5 pb-4"
      style={{ width: sidebarWidth }}
    >
      <DesktopTopBar
        testId="desktop-sidebar-topbar"
        className="-mx-1.5 w-[calc(100%+0.75rem)] bg-transparent px-2"
        left={<DesktopWindowControls sidebarCollapsed={false} onToggleSidebar={onCollapse} />}
      />

      <nav className="space-y-0.5">
        <SidebarButton
          icon={Plus}
          label={t('workbench.new_chat', '新对话')}
          testId="new-chat-button"
          onClick={onNewChat}
        />
        <SidebarButton
          icon={Sparkles}
          label={t('workbench.plugins', '插件')}
          testId="plugins-button"
          selected={activeItem === 'plugins'}
          onClick={onOpenPlugins}
        />
      </nav>

      <div
        data-testid="sidebar-worklists-scroll"
        className="scrollbar-none mt-8 min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
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
                  triggerClassName="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                />
                <button
                  type="button"
                  aria-label={t('workbench.new_project', '新建项目')}
                  data-testid="projects-create-button"
                  onClick={event => {
                    event.stopPropagation()
                    openProjectCreateMenu(event.currentTarget)
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
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
                  currentRuntimeTask={currentRuntimeTask}
                  imNotificationSettings={imNotificationSettings}
                  showDeviceMarker={false}
                  onToggleProject={handleToggleProject}
                  onStartNewProjectChat={onStartNewProjectChat}
                  onRemoveProject={onRemoveProject}
                  onRenameProject={setRenamingProject}
                  onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
                  onRenameRuntimeLocalTask={onRenameRuntimeLocalTask}
                  onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
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
                triggerClassName="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
              />
              <button
                type="button"
                aria-label={t('workbench.new_chat', '新对话')}
                data-testid="runtime-chat-section-new-chat-button"
                onClick={event => {
                  event.stopPropagation()
                  onNewChat()
                }}
                className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
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
                  <RuntimeLocalTaskRow
                    key={`${workspace.deviceId}:${task.workspacePath}:${task.localTaskId}`}
                    workspace={workspace}
                    task={task}
                    selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                    indentClassName="pl-2.5"
                    imNotificationSettings={imNotificationSettings}
                    showDeviceMarker={false}
                    onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
                    onRenameRuntimeLocalTask={onRenameRuntimeLocalTask}
                    onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
                    onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                  />
                ))
              )}
            </div>
          )}
        </section>
      </div>

      <div ref={settingsMenuRef} className="mt-4 flex shrink-0 flex-col gap-1">
        {onToggleGlobalImNotification && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="sidebar-global-im-notification-button"
              aria-pressed={Boolean(imNotificationSettings?.global.enabled)}
              onClick={() => {
                void onToggleGlobalImNotification()
              }}
              className={cn(
                'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium leading-[18px] hover:bg-[rgb(var(--color-sidebar-hover))]',
                imNotificationSettings?.global.enabled
                  ? 'text-primary'
                  : 'text-[rgb(var(--color-sidebar-text-primary))]'
              )}
              title={getGlobalImNotificationTitle(t, imNotificationSettings)}
            >
              <Bell
                className={cn('h-4 w-4', imNotificationSettings?.global.enabled && 'fill-current')}
              />
              <span className="min-w-0 truncate">
                {t('workbench.global_im_notifications_short', 'IM通知')}
              </span>
            </button>
            {onOpenGlobalImNotificationSettings && (
              <button
                type="button"
                data-testid="sidebar-global-im-notification-settings-button"
                onClick={() => {
                  void onOpenGlobalImNotificationSettings()
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                title={t('workbench.global_im_notification_channel_settings', '设置通知通道')}
                aria-label={t('workbench.global_im_notification_channel_settings', '设置通知通道')}
              >
                <Settings className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="settings-button"
            onClick={() => setSettingsMenuOpen(open => !open)}
            className="flex h-9 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium leading-[18px] text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
            aria-expanded={settingsMenuOpen}
          >
            <Settings className="h-4 w-4" />
            {t('workbench.settings', '设置')}
          </button>
          {onRefreshWorkLists && (
            <button
              type="button"
              data-testid="refresh-worklists-button"
              disabled={isRefreshing}
              onClick={async () => {
                if (isRefreshing) return
                setIsRefreshing(true)
                try {
                  await onRefreshWorkLists()
                } finally {
                  setIsRefreshing(false)
                }
              }}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-60"
              title={t('workbench.refresh_worklists', '刷新')}
              aria-label={t('workbench.refresh_worklists', '刷新')}
            >
              <RotateCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
            </button>
          )}
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

      <button
        type="button"
        data-testid="sidebar-resize-handle"
        onPointerDown={handleResizeStart}
        className="absolute right-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
        aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
      />

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
        devices={devices}
        preferredDeviceId={preferredDeviceId}
        onClose={() => setStandaloneWorkspaceDialogMode(null)}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
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
    </aside>
  )
}
