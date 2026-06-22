import {
  Archive,
  Bell,
  ChevronRight,
  Edit3,
  Folder,
  FolderPlus,
  GitCompareArrows,
  MessageSquarePlus,
  Pin,
  Plus,
  RotateCw,
  Settings,
  Sparkles,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  DeviceInfo,
  GitBranch,
  GitRepoInfo,
  LocalTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectWork,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User as UserProfile,
} from '@/types/api'
import type { DeviceUpgradeState } from '@/types/device-events'
import { DesktopSettingsMenu } from './DesktopSettingsMenu'
import { DesktopTopBar } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import {
  getRuntimeChatSidebarTaskItems,
  getRuntimeDirectoryWorkspaces,
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  getRuntimeTaskWorkspaceTitle,
  getRuntimeSidebarTaskItems,
  getRuntimeWorkspaceLabel,
  getVisibleRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  isRuntimeTaskSelected,
  isRuntimeWorktreeTask,
  sortRuntimeTasks,
} from './runtimeTaskSidebarHelpers'
import { useResizableSidebar } from './useResizableSidebar'

interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentRuntimeTask?: RuntimeTaskAddress | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  preferredDeviceId?: string | null
  upgradingDevices?: Record<string, DeviceUpgradeState>
  activeItem?: 'chat' | 'plugins' | 'automation'
  onCollapse: () => void
  onNewChat: () => void
  onSelectProject: (projectId: number) => void
  onStartNewProjectChat: (projectId: number) => void
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
  onToggleGlobalImNotification?: () => Promise<void> | void
  onOpenGlobalImNotificationSettings?: () => Promise<void> | void
  onRememberExecutionDevice?: (deviceId: string) => void
  onOpenPlugins: () => void
  onRefreshDevices?: () => Promise<void>
  onUpgradeDevice?: (deviceId: string) => Promise<void>
  onCreateProject: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject: (data: CreateGitWorkspaceProjectRequest) => Promise<ProjectWithTasks>
  onPrepareDeviceWorkspace: (
    data: DeviceWorkspacePrepareRequest
  ) => Promise<DeviceWorkspacePrepareResponse>
  onListGitRepositories: () => Promise<GitRepoInfo[]>
  onListGitBranches: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenSettings: (options?: { autoOpenAddCloudDeviceDialog?: boolean }) => void
  onRefreshWorkLists?: () => Promise<void>
  onLogout: () => void
}

type ProjectCreateMode = 'scratch' | 'existing' | 'git'

const SIDEBAR_ROW_METADATA_CLASS =
  'flex items-center gap-1 text-xs text-[rgb(var(--color-sidebar-text-muted))] group-hover/task:invisible'

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

function getRuntimeWorkspaceDeviceColor(workspace: RuntimeDeviceWorkspace): string {
  return getSidebarDeviceColor(getSidebarDeviceColorKey(workspace.deviceName, workspace.deviceId))
}

function getRuntimeWorkspaceTaskCount(workspaces: RuntimeDeviceWorkspace[]): number {
  return workspaces.reduce((count, workspace) => count + workspace.localTasks.length, 0)
}

function filterRuntimeWorkspacesByDevice(
  workspaces: RuntimeDeviceWorkspace[],
  deviceId: string | null
): RuntimeDeviceWorkspace[] {
  if (!deviceId) return workspaces
  return workspaces.filter(workspace => workspace.deviceId === deviceId)
}

function filterRuntimeProjectWorkByDevice(
  projectWork: RuntimeProjectWork,
  deviceId: string | null
): RuntimeProjectWork {
  if (!deviceId) return projectWork

  const deviceWorkspaces = filterRuntimeWorkspacesByDevice(projectWork.deviceWorkspaces, deviceId)
  return {
    ...projectWork,
    deviceWorkspaces,
    totalLocalTasks: getRuntimeWorkspaceTaskCount(deviceWorkspaces),
  }
}

function SidebarOnlineDevices({
  devices,
  expanded,
  offlineExpanded,
  selectedDeviceId,
  onToggleExpanded,
  onToggleOfflineExpanded,
  onSelectDevice,
  onAddDevice,
}: {
  devices: DeviceInfo[]
  expanded: boolean
  offlineExpanded: boolean
  selectedDeviceId: string | null
  onToggleExpanded: () => void
  onToggleOfflineExpanded: () => void
  onSelectDevice: (deviceId: string) => void
  onAddDevice: () => void
}) {
  const { t } = useTranslation('common')
  const onlineDevices = useMemo(
    () => devices.filter(device => device.status === 'online'),
    [devices]
  )
  const offlineDevices = useMemo(
    () => devices.filter(device => device.status !== 'online'),
    [devices]
  )
  const selectedDevice = devices.find(device => device.device_id === selectedDeviceId) ?? null
  const selectedOfflineDevice =
    selectedDevice && selectedDevice.status !== 'online' ? selectedDevice : null
  const visibleOfflineDevices = offlineExpanded
    ? offlineDevices
    : selectedOfflineDevice
      ? [selectedOfflineDevice]
      : []
  const visibleDevices = [...onlineDevices, ...visibleOfflineDevices]

  return (
    <section data-testid="sidebar-online-devices" className="mb-6 px-2.5">
      <div
        data-testid="sidebar-devices-header"
        className="mb-1.5 flex h-5 items-center justify-between gap-2"
      >
        <button
          type="button"
          data-testid="sidebar-devices-section-toggle"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left text-[12px] font-semibold leading-4 text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 transition-transform',
              expanded ? 'rotate-90' : 'rotate-0'
            )}
          />
          <span className="shrink-0">{t('workbench.online_devices', '在线设备')}</span>
          <span className="shrink-0 text-[11px] font-medium text-[rgb(var(--color-sidebar-text-secondary))]">
            {onlineDevices.length}
          </span>
          {selectedDevice && (
            <span className="min-w-0 truncate text-[11px] font-medium text-[rgb(var(--color-sidebar-text-secondary))]">
              {selectedDevice.name || selectedDevice.device_id}
            </span>
          )}
        </button>
        {offlineDevices.length > 0 && (
          <button
            type="button"
            data-testid="sidebar-offline-devices-toggle"
            onClick={() => {
              if (!offlineExpanded && !expanded) {
                onToggleExpanded()
              }
              onToggleOfflineExpanded()
            }}
            className="h-5 shrink-0 rounded-sm px-1 text-[11px] font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
          >
            {offlineExpanded
              ? t('workbench.hide_offline_devices', '收起离线')
              : t('workbench.show_offline_devices', {
                  count: offlineDevices.length,
                  defaultValue: '离线 {{count}}',
                })}
          </button>
        )}
        <button
          type="button"
          data-testid="sidebar-add-device-button"
          aria-label={t('workbench.add_device')}
          title={t('workbench.add_device')}
          onClick={onAddDevice}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-secondary))]"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <div data-testid="sidebar-device-list" className="space-y-0.5">
          {visibleDevices.map(device => {
            const deviceName = device.name || device.device_id
            const color = getSidebarDeviceColor(
              getSidebarDeviceColorKey(device.name, device.device_id)
            )
            const selected = selectedDeviceId === device.device_id
            const deviceState: SidebarDeviceState = {
              deviceId: device.device_id,
              device,
              status: device.status,
            }

            return (
              <button
                type="button"
                key={device.device_id}
                data-testid={`sidebar-online-device-${device.device_id}`}
                aria-pressed={selected}
                onClick={() => onSelectDevice(device.device_id)}
                title={deviceName}
                className={cn(
                  'flex h-5 w-full min-w-0 items-center gap-2 rounded-sm text-left text-[12px] leading-4 hover:text-[rgb(var(--color-sidebar-text-primary))]',
                  selected
                    ? 'font-semibold text-[rgb(var(--color-sidebar-text-primary))]'
                    : 'font-medium text-[rgb(var(--color-sidebar-text-secondary))]',
                  device.status !== 'online' && 'opacity-70'
                )}
              >
                <span
                  data-testid={`sidebar-online-device-color-${device.device_id}`}
                  aria-hidden="true"
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full opacity-90',
                    selected && 'h-2.5 w-2.5'
                  )}
                  style={{ backgroundColor: color }}
                />
                <span className="min-w-0 truncate">{deviceName}</span>
                <SidebarDeviceStatusIndicator
                  deviceState={deviceState}
                  testId={`sidebar-device-status-${device.device_id}`}
                  className="ml-auto"
                />
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
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

function SidebarDeviceStatusIndicator({
  deviceState,
  testId,
  className,
}: {
  deviceState: SidebarDeviceState
  testId: string
  className?: string
}) {
  const { t } = useTranslation('common')
  if (deviceState.status === 'online') return null

  const label = getSidebarDeviceStatusLabel(t, deviceState.status)
  const deviceName = getSidebarDeviceName(deviceState)
  const title = formatSidebarTemplate(
    t('workbench.project_device_status_title', '{{device}} · {{status}}'),
    { device: deviceName, status: label }
  )

  return (
    <span
      data-testid={testId}
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full text-[11px] leading-4 text-[rgb(var(--color-sidebar-text-muted))]',
        className
      )}
    >
      <span className="shrink-0">{label}</span>
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
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const [marked, setMarked] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const worktreeTask = isRuntimeWorktreeTask(task)
  const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
  const deviceColor = getRuntimeWorkspaceDeviceColor(workspace)
  const disabled = !workspace.available || !onOpenRuntimeLocalTask
  const archiveDisabled = !workspace.available || !onArchiveRuntimeLocalTask || archiving
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
  const handleToggleMark = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    setMarked(value => !value)
  }
  const handleArchive = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    event.currentTarget.blur()
    if (archiveDisabled) return
    setArchiving(true)
    void Promise.resolve(onArchiveRuntimeLocalTask?.(taskAddress)).finally(() => {
      setArchiving(false)
    })
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
    <div
      data-testid={`runtime-local-task-row-${task.localTaskId}`}
      data-marked={marked ? 'true' : 'false'}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={handleOpen}
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
      <span title={task.title} className="min-w-0 flex-1 truncate group-hover/task:pr-20">
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
            {formatRelativeSidebarTime(getRuntimeTaskTime(task))}
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
          className="pointer-events-none invisible absolute right-0 top-1/2 flex w-[78px] -translate-y-1/2 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:visible group-hover/task:opacity-100"
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
            data-testid={`runtime-local-task-mark-${task.localTaskId}`}
            onClick={handleToggleMark}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]',
              marked && 'text-[rgb(var(--color-sidebar-marked-accent))]'
            )}
            title={
              marked
                ? t('workbench.unmark_runtime_task', '取消标记')
                : t('workbench.mark_runtime_task', '标记')
            }
            aria-label={
              marked
                ? t('workbench.unmark_runtime_task', '取消标记')
                : t('workbench.mark_runtime_task', '标记')
            }
          >
            <Pin
              data-testid={`runtime-local-task-pin-icon-${task.localTaskId}`}
              className={cn('h-4 w-4', marked && 'fill-current')}
            />
          </button>
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
  )
}

function RuntimeWorkspaceGroup({
  workspace,
  currentRuntimeTask,
  imNotificationSettings,
  showDeviceMarker,
  onOpenRuntimeLocalTask,
  onArchiveRuntimeLocalTask,
  onToggleRuntimeTaskNotification,
}: {
  workspace: RuntimeDeviceWorkspace
  currentRuntimeTask?: RuntimeTaskAddress | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onToggleRuntimeTaskNotification?: (
    address: RuntimeTaskAddress,
    subscribed: boolean
  ) => Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const sortedTasks = useMemo(() => sortRuntimeTasks(workspace.localTasks), [workspace.localTasks])
  const deviceState: SidebarDeviceState = {
    deviceId: workspace.deviceId,
    status: workspace.available
      ? (workspace.deviceStatus as SidebarDeviceStatus) || 'online'
      : 'unavailable',
  }
  const title = `${workspace.deviceName || workspace.deviceId} · ${workspace.workspacePath}`

  return (
    <div
      data-testid={`runtime-workspace-row-${workspace.id ?? workspace.workspacePath}`}
      className="space-y-0.5"
    >
      <div
        className={cn(
          'flex h-8 min-w-0 items-center rounded-md pl-9 pr-2 text-[13px] leading-[18px]',
          workspace.available
            ? 'text-[rgb(var(--color-sidebar-text-secondary))]'
            : 'text-[rgb(var(--color-sidebar-text-muted))] opacity-70'
        )}
        title={title}
      >
        <Folder className="mr-2 h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-secondary))]" />
        <span className="min-w-0 flex-1 truncate">{getRuntimeWorkspaceLabel(workspace)}</span>
        {!workspace.available && (
          <SidebarDeviceStatusIndicator
            deviceState={deviceState}
            testId={`runtime-workspace-device-status-${workspace.id ?? workspace.deviceId}`}
          />
        )}
      </div>
      {sortedTasks.length === 0 ? (
        <div
          data-testid={`runtime-workspace-empty-${workspace.id ?? workspace.workspacePath}`}
          className="ml-14 rounded-md px-2 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
        >
          {t('workbench.no_chats', '暂无会话')}
        </div>
      ) : (
        sortedTasks.map(task => (
          <RuntimeLocalTaskRow
            key={task.localTaskId}
            workspace={workspace}
            task={task}
            selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
            imNotificationSettings={imNotificationSettings}
            showDeviceMarker={showDeviceMarker}
            onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
            onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
            onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
          />
        ))
      )}
    </div>
  )
}

function ProjectItem({
  project,
  expanded,
  onToggleProject,
  onSelectProject,
  devices,
  runtimeProjectWork,
  currentRuntimeTask,
  imNotificationSettings,
  showDeviceMarker,
  onStartNewProjectChat,
  onRemoveProject,
  onEditProject,
  onRenameProject,
  onOpenRuntimeLocalTask,
  onArchiveRuntimeLocalTask,
  onToggleRuntimeTaskNotification,
}: {
  project: ProjectWithTasks
  expanded: boolean
  onToggleProject: (projectId: number) => void
  onSelectProject: (projectId: number) => void
  devices: DeviceInfo[]
  runtimeProjectWork?: RuntimeProjectWork
  currentRuntimeTask?: RuntimeTaskAddress | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  showDeviceMarker: boolean
  onStartNewProjectChat: (projectId: number) => void
  onRemoveProject: (projectId: number) => Promise<void>
  onEditProject: (project: ProjectWithTasks) => void
  onRenameProject: (project: ProjectWithTasks) => void
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
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
  const visibleRuntimeTaskItems = useMemo(
    () => getVisibleRuntimeSidebarTaskItems(runtimeTaskItems, runtimeTasksExpanded),
    [runtimeTaskItems, runtimeTasksExpanded]
  )
  const hasHiddenRuntimeTasks = hasHiddenRuntimeSidebarTaskItems(runtimeTaskItems)
  const projectDeviceState = getSidebarDeviceState(getProjectDeviceId(project), devices)
  const canStartProjectChat = isSidebarDeviceOnline(projectDeviceState)
  const newProjectChatTitle =
    projectDeviceState && !canStartProjectChat
      ? getDeviceUnavailableActionTitle(t, projectDeviceState)
      : t('workbench.new_project_chat', '新建项目对话')

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
            onSelectProject(project.id)
            onToggleProject(project.id)
          }}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2.5 pr-16 text-left"
        >
          <ProjectFolderIcon
            project={project}
            className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-sidebar-text-secondary))]"
          />
          <span className="min-w-0 flex-1 truncate" title={project.name}>
            {project.name}
          </span>
          {projectDeviceState && (
            <SidebarDeviceStatusIndicator
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
                label: t('workbench.edit_project', '编辑项目'),
                icon: Settings,
                testId: `edit-project-${project.id}`,
                onSelect: () => onEditProject(project),
              },
              {
                label: t('workbench.rename_project', '重命名项目'),
                icon: Edit3,
                testId: `rename-project-${project.id}`,
                onSelect: () => onRenameProject(project),
              },
              {
                label: t('workbench.remove_project', '移除'),
                icon: X,
                testId: `remove-project-${project.id}`,
                danger: true,
                onSelect: () => onRemoveProject(project.id),
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
    </div>
  )
}

export function DesktopSidebar({
  user,
  projects,
  devices,
  runtimeWork,
  currentRuntimeTask,
  imNotificationSettings,
  preferredDeviceId,
  upgradingDevices = {},
  activeItem = 'chat',
  onCollapse,
  onNewChat,
  onSelectProject,
  onStartNewProjectChat,
  onOpenRuntimeLocalTask,
  onArchiveRuntimeLocalTask,
  onToggleRuntimeTaskNotification,
  onToggleGlobalImNotification,
  onOpenGlobalImNotificationSettings,
  onRememberExecutionDevice,
  onOpenPlugins,
  onRefreshDevices,
  onUpgradeDevice,
  onCreateProject,
  onCreateGitWorkspaceProject,
  onPrepareDeviceWorkspace,
  onListGitRepositories,
  onListGitBranches,
  onUpdateProjectName,
  onRemoveProject,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
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
  const unmappedExpandedStorageKey = getDesktopSidebarStorageKey(
    storageScope,
    'unmappedRuntimeExpanded'
  )
  const expandedProjectIdsStorageKey = getDesktopSidebarStorageKey(
    storageScope,
    'expandedProjectIds'
  )
  const storageScopeRef = useRef(storageScope)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const [projectCreateMode, setProjectCreateMode] = useState<ProjectCreateMode | null>(null)
  const [editingProject, setEditingProject] = useState<ProjectWithTasks | null>(null)
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [projectsExpanded, setProjectsExpanded] = useState(() =>
    readStoredBoolean(projectsExpandedStorageKey, true)
  )
  const [unmappedExpanded, setUnmappedExpanded] = useState(() =>
    readStoredBoolean(unmappedExpandedStorageKey, true)
  )
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() =>
    readStoredNumberSet(expandedProjectIdsStorageKey)
  )
  const [devicesExpanded, setDevicesExpanded] = useState(false)
  const [offlineDevicesExpanded, setOfflineDevicesExpanded] = useState(false)
  const [selectedDeviceFilterId, setSelectedDeviceFilterId] = useState<string | null>(null)
  const activeDeviceFilterId =
    selectedDeviceFilterId && devices.some(device => device.device_id === selectedDeviceFilterId)
      ? selectedDeviceFilterId
      : null
  const visibleExpandedProjectIds = useMemo(
    () => pruneProjectIdSet(expandedProjectIds, projects),
    [expandedProjectIds, projects]
  )
  const filteredRuntimeProjects = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return items.map(item => filterRuntimeProjectWorkByDevice(item, activeDeviceFilterId))
  }, [runtimeWork?.projects, activeDeviceFilterId])
  const runtimeWorkByProjectId = useMemo(() => {
    return new Map(filteredRuntimeProjects.map(item => [item.project.id, item]))
  }, [filteredRuntimeProjects])
  const unmappedWorkspaces = useMemo(
    () =>
      filterRuntimeWorkspacesByDevice(
        runtimeWork?.unmappedDeviceWorkspaces ?? [],
        activeDeviceFilterId
      ),
    [runtimeWork?.unmappedDeviceWorkspaces, activeDeviceFilterId]
  )
  const unmappedDirectoryWorkspaces = useMemo(
    () => getRuntimeDirectoryWorkspaces(unmappedWorkspaces),
    [unmappedWorkspaces]
  )
  const unmappedChatTaskItems = useMemo(
    () => getRuntimeChatSidebarTaskItems(unmappedWorkspaces),
    [unmappedWorkspaces]
  )
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
  const selectedRuntimeInUnmapped = useMemo(() => {
    if (!currentRuntimeTask) return false
    return unmappedDirectoryWorkspaces.some(workspace =>
      workspace.localTasks.some(task => isRuntimeTaskSelected(currentRuntimeTask, workspace, task))
    )
  }, [currentRuntimeTask, unmappedDirectoryWorkspaces])
  const displayedProjectsExpanded = projectsExpanded || selectedRuntimeProjectId !== null
  const displayedUnmappedExpanded = unmappedExpanded || selectedRuntimeInUnmapped
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

  const handleSelectDeviceFilter = (deviceId: string) => {
    setSelectedDeviceFilterId(previous => (previous === deviceId ? null : deviceId))
  }

  const openProjectCreateDialog = () => {
    setProjectCreateMode('scratch')
    setEditingProject(null)
    void onRefreshDevices?.().catch(() => undefined)
  }

  const openProjectEditDialog = (project: ProjectWithTasks) => {
    setEditingProject(project)
    setProjectCreateMode(null)
    void onRefreshDevices?.().catch(() => undefined)
  }

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredBoolean(projectsExpandedStorageKey, projectsExpanded)
  }, [projectsExpanded, projectsExpandedStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredBoolean(unmappedExpandedStorageKey, unmappedExpanded)
  }, [unmappedExpanded, unmappedExpandedStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredNumberSet(expandedProjectIdsStorageKey, expandedProjectIds)
  }, [expandedProjectIds, expandedProjectIdsStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current === storageScope) return

    storageScopeRef.current = storageScope
    setProjectsExpanded(readStoredBoolean(projectsExpandedStorageKey, true))
    setUnmappedExpanded(readStoredBoolean(unmappedExpandedStorageKey, true))
    setExpandedProjectIds(readStoredNumberSet(expandedProjectIdsStorageKey))
  }, [
    expandedProjectIdsStorageKey,
    projectsExpandedStorageKey,
    storageScope,
    unmappedExpandedStorageKey,
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
    if (!currentRuntimeTask) return

    const taskRow = document.querySelector(
      `[data-testid="runtime-local-task-row-${currentRuntimeTask.localTaskId}"]`
    )

    taskRow?.scrollIntoView({ block: 'nearest' })
  }, [
    currentRuntimeTask,
    displayedExpandedProjectIds,
    displayedProjectsExpanded,
    displayedUnmappedExpanded,
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
        className="scrollbar-none mt-8 min-h-0 flex-1 overflow-y-auto"
      >
        <SidebarOnlineDevices
          devices={devices}
          expanded={devicesExpanded}
          offlineExpanded={offlineDevicesExpanded}
          selectedDeviceId={activeDeviceFilterId}
          onToggleExpanded={() => setDevicesExpanded(expanded => !expanded)}
          onToggleOfflineExpanded={() => setOfflineDevicesExpanded(expanded => !expanded)}
          onSelectDevice={handleSelectDeviceFilter}
          onAddDevice={() => onOpenSettings({ autoOpenAddCloudDeviceDialog: true })}
        />

        <section>
          <SidebarSectionHeader
            title={t('workbench.projects', '项目')}
            expanded={displayedProjectsExpanded}
            hasContent={projects.length > 0}
            toggleTestId="projects-section-toggle"
            iconTestId="projects-section-chevron-right"
            onToggle={() => setProjectsExpanded(expanded => !expanded)}
          >
            <button
              type="button"
              aria-label={t('workbench.new_project', '新建项目')}
              data-testid="projects-create-button"
              onClick={event => {
                event.stopPropagation()
                openProjectCreateDialog()
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </SidebarSectionHeader>
          {displayedProjectsExpanded && (
            <div className="space-y-1">
              {projects.map(project => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  expanded={displayedExpandedProjectIds.has(project.id)}
                  devices={devices}
                  runtimeProjectWork={runtimeWorkByProjectId.get(project.id)}
                  currentRuntimeTask={currentRuntimeTask}
                  imNotificationSettings={imNotificationSettings}
                  showDeviceMarker={devicesExpanded}
                  onToggleProject={handleToggleProject}
                  onSelectProject={onSelectProject}
                  onStartNewProjectChat={onStartNewProjectChat}
                  onRemoveProject={onRemoveProject}
                  onEditProject={openProjectEditDialog}
                  onRenameProject={setRenamingProject}
                  onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
                  onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
                  onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                />
              ))}
            </div>
          )}
        </section>

        {unmappedChatTaskItems.length > 0 && (
          <section data-testid="runtime-chat-section" className="mt-8">
            <div className="mb-2 flex h-7 items-center px-2.5">
              <span className="truncate text-[13px] font-semibold leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]">
                {t('workbench.chats', '对话')}
              </span>
            </div>
            <div className="space-y-0.5 pb-2">
              {unmappedChatTaskItems.map(({ workspace, task }) => (
                <RuntimeLocalTaskRow
                  key={`${workspace.deviceId}:${task.workspacePath}:${task.localTaskId}`}
                  workspace={workspace}
                  task={task}
                  selected={isRuntimeTaskSelected(currentRuntimeTask, workspace, task)}
                  indentClassName="pl-2.5"
                  imNotificationSettings={imNotificationSettings}
                  showDeviceMarker={devicesExpanded}
                  onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
                  onArchiveRuntimeLocalTask={onArchiveRuntimeLocalTask}
                  onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                />
              ))}
            </div>
          </section>
        )}

        <section data-testid="unmapped-runtime-section" className="mt-8">
          <SidebarSectionHeader
            title={t('workbench.unmapped_device_workspaces', '未映射工作区')}
            expanded={displayedUnmappedExpanded}
            hasContent={unmappedDirectoryWorkspaces.length > 0}
            toggleTestId="unmapped-runtime-section-toggle"
            iconTestId="unmapped-runtime-section-chevron-right"
            onToggle={() => setUnmappedExpanded(expanded => !expanded)}
          >
            <span />
          </SidebarSectionHeader>
          {displayedUnmappedExpanded && (
            <div className="space-y-1 pb-2">
              {unmappedDirectoryWorkspaces.length === 0 ? (
                <div className="ml-2 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]">
                  {t('workbench.no_unmapped_device_workspaces', '暂无未映射工作区')}
                </div>
              ) : (
                unmappedDirectoryWorkspaces.map(workspace => (
                  <RuntimeWorkspaceGroup
                    key={`${workspace.deviceId}:${workspace.workspacePath}`}
                    workspace={workspace}
                    currentRuntimeTask={currentRuntimeTask}
                    imNotificationSettings={imNotificationSettings}
                    showDeviceMarker={devicesExpanded}
                    onOpenRuntimeLocalTask={onOpenRuntimeLocalTask}
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

      <ProjectCreateDialog
        open={projectCreateMode !== null || editingProject !== null}
        mode={editingProject ? 'existing' : (projectCreateMode ?? 'scratch')}
        project={editingProject}
        devices={devices}
        onClose={() => {
          setProjectCreateMode(null)
          setEditingProject(null)
        }}
        onOpenCloudDeviceSettings={() => {
          setProjectCreateMode(null)
          setEditingProject(null)
          onOpenSettings({ autoOpenAddCloudDeviceDialog: true })
        }}
        onCreateProject={onCreateProject}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        preferredDeviceId={preferredDeviceId}
        onSelectDevicePreference={onRememberExecutionDevice}
        upgradingDevices={upgradingDevices}
        onUpgradeDevice={onUpgradeDevice}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onListGitRepositories={onListGitRepositories}
        onListGitBranches={onListGitBranches}
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
