import {
  Archive,
  AlarmClock,
  ArrowDown,
  ArrowUp,
  Bell,
  ChevronDown,
  ChevronRight,
  Columns2,
  Edit3,
  FolderOpen,
  FolderPlus,
  Globe2,
  GitCompareArrows,
  Laptop,
  Loader2,
  MessageCircle,
  MessageCircleOff,
  MessageSquarePlus,
  Pause,
  Pin,
  Plus,
  RotateCw,
  Search,
  SquareTerminal,
  Sparkles,
  X,
} from 'lucide-react'
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent,
  PointerEventHandler,
  RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ActionMenu } from '@/components/common/ActionMenu'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { TextInputDialog } from '@/components/common/TextInputDialog'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { LocalProjectEditDialog } from '@/components/projects/LocalProjectEditDialog'
import { createLocalCodexPluginApi } from '@/api/local/codexPlugins'
import { TitlebarTooltip } from '@/components/topnav/TitlebarTooltip'
import { AppReleaseNotesDialog } from '@/features/app-update/AppReleaseNotesDialog'
import { useOptionalAppUpdate } from '@/features/app-update/app-update-context'
import type { WeworkInstalledReleaseNotes } from '@/features/app-update/app-release-notes'
import type { WeworkDshSidebarNavigationItem } from '@/features/dsh-runtime/dshSidebarNavigation'
import { DshIcon } from '@/features/dsh-runtime/DshIcon'
import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import { getRuntimeTaskReminderItemKey } from '@/features/workbench/runtimeTaskReminders'
import { getRuntimeTaskThreadId } from '@/features/workbench/workbenchRuntimeHelpers'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import {
  getRuntimeConversationQueuePaused,
  subscribeRuntimeConversation,
} from '@/features/workbench/runtimeConversationCache'
import {
  getRuntimeTaskLifecycleKey,
  useRuntimeTaskLifecycle,
  useRuntimeTaskLifecycleStoreSnapshot,
} from '@/features/workbench/runtimeTaskLifecycle'
import { CloudConnectionDialog } from '@/features/cloud-connection/CloudConnectionDialog'
import type { CloudConnectionStatus } from '@/features/cloud-connection/cloudConnectionStorage'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { DshSidebarNavigationSurface } from '@/features/dsh-runtime/DshSidebarNavigationSurface'
import { prefetchDshSidebarNavigation } from '@/features/dsh-runtime/dshSidebarNavigation'
import { useExperimentalFeaturesEnabled } from '@/features/experimental-features/useExperimentalFeaturesEnabled'
import {
  StandaloneFolderProjectDialog,
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useConfiguredKeybinding } from '@/hooks/useConfiguredKeybinding'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canUseForProjectCreation,
  isCloudDevice,
  isClaudeCodeDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import { fileManagerRevealLabel } from '@/lib/file-manager'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import {
  isEditableShortcutTarget,
  keybindingFromKeyboardEvent,
  TOGGLE_PRIORITY_FILTER_COMMAND,
} from '@/lib/keybindings'
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
  CloneGitRepositoryInput,
  DeviceInfo,
  GitCloneProjectOperation,
  RuntimeTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectWork,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectAiSettings,
  RuntimeProjectSpaceRef,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeProjectTaskReorderRequest,
  RuntimeTaskPinRequest,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
  User as UserProfile,
} from '@/types/api'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'
import type { CloudWorkStatus } from '@/types/workbench'
import type {
  ArchiveRuntimeConversationsResult,
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'
import { getWorkbenchPaneKey } from './workbenchPaneIdentity'
import {
  DesktopSidebarAccount,
  type DesktopSidebarAccountSettingsOptions,
} from './DesktopSidebarAccount'
import { DesktopWindowControls } from './DesktopWindowControls'
import {
  DesktopSidebarHeader,
  DesktopSidebarNavItem,
  DesktopSidebarSectionHeader,
} from './DesktopSidebarPrimitives'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import { SidebarSortableList } from './SidebarSortableList'
import { SidebarHoverCard } from './SidebarHoverCard'
import { DesktopSidebarPrioritySection } from './DesktopSidebarPrioritySection'
import {
  createDesktopSidebarPrioritySession,
  reconcileDesktopSidebarPrioritySession,
  selectDesktopSidebarPriorityView,
  type DesktopSidebarPrioritySession,
  type DesktopSidebarPrioritySource,
} from './desktopSidebarPriorityView'
import {
  ProjectSidebarHoverCardContent,
  type ProjectHoverSource,
} from './ProjectSidebarHoverCardContent'
import { TaskSidebarHoverCardContent } from './TaskSidebarHoverCardContent'
import { useSidebarPaneDragScrollLock } from './useSidebarPaneDragScrollLock'
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
  isRuntimeTaskQueued,
  isRuntimeTaskSelected,
  isRuntimeWorktreeTask,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'
import { debugRuntimeSidebarState } from '@/features/workbench/runtimeSidebarDiagnostics'
import { formatRelativeSidebarTime, useSidebarRelativeTimeRefresh } from './runtimeSidebarTime'
import { useResizableSidebar } from './useResizableSidebar'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import type { WorkbenchSplitGroupMembership } from './workbenchSplitGroups'

interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  cloudWorkStatus?: CloudWorkStatus
  runtimeWork?: RuntimeWorkListResponse | null
  gitCloneOperations?: GitCloneProjectOperation[]
  currentRuntimeTask?: RuntimeTaskAddress | null
  splitGroupMemberships?: Readonly<Record<string, WorkbenchSplitGroupMembership>>
  standaloneDeviceId?: string | null
  standaloneWorkspacePath?: string | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  unreadRuntimeTaskKeys?: ReadonlySet<string>
  preferredDeviceId?: string | null
  activeItem?: 'chat' | 'plugins' | 'sites' | 'cloud-work' | 'automation'
  localHarnessSessions?: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSessionId?: string | null
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
  onNewChat: () => void
  onStartStandaloneChat: () => void
  onOpenLocalHarnessSession?: (sessionId: string) => void
  onCloseLocalHarnessSession?: (sessionId: string) => void | Promise<void>
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
  onRefreshDevices?: () => Promise<void>
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
  onUpdateLocalRuntimeProject?: (data: {
    deviceId: string
    projectKey: string
    name: string
    roots: string[]
    defaultProjectSpace: RuntimeProjectSpaceRef | null
    aiSettings: RuntimeProjectAiSettings | null
  }) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onReorderRuntimeProjects?: (data: RuntimeProjectReorderRequest) => Promise<void>
  onSetRuntimeProjectPinned?: (data: RuntimeProjectPinRequest) => Promise<void>
  onSetRuntimeProjectAppearance?: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  onReorderRuntimeProjectTasks?: (data: RuntimeProjectTaskReorderRequest) => Promise<void>
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onCloneGitRepository?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  onStartGitCloneProject?: (deviceId: string, input: CloneGitRepositoryInput) => void
  onRetryGitCloneOperation?: (operation: GitCloneProjectOperation) => void
  onDismissGitCloneOperation?: (operationId: string) => void
  projectSpaceApis?: ProjectSpaceApi[]
  models?: UnifiedModel[]
  onOpenSettings: (options?: OpenSettingsOptions) => void
  onLogout: () => void
}

interface RuntimeTaskPinMutation {
  createdRevision: number
  requestId: number
  status: 'pending' | 'succeeded'
  value: boolean
}

interface RuntimeTaskPinOverride {
  mutations: RuntimeTaskPinMutation[]
}

function getRuntimeTaskPinOverrideKey(deviceId: string, threadId: string) {
  return `${deviceId}\0${threadId}`
}

function getRuntimeTaskPinnedValue(
  persistedPinned: boolean,
  override: RuntimeTaskPinOverride | undefined
) {
  return override?.mutations[override.mutations.length - 1]?.value ?? persistedPinned
}

function reconcileRuntimeTaskPinOverride(
  override: RuntimeTaskPinOverride,
  persistedPinned: boolean,
  revision: number
) {
  let acknowledgedMutationIndex = -1
  for (const [index, mutation] of override.mutations.entries()) {
    if (mutation.status !== 'succeeded') break
    if (mutation.createdRevision < revision && mutation.value === persistedPinned) {
      acknowledgedMutationIndex = index
    }
  }
  if (acknowledgedMutationIndex < 0) return override

  const mutations = override.mutations.slice(acknowledgedMutationIndex + 1)
  return mutations.length > 0 ? { mutations } : null
}

function reconcileRuntimeTaskPinOverrides(
  overrides: Map<string, RuntimeTaskPinOverride>,
  persistedPinStates: Map<string, boolean>,
  revision: number
) {
  let next = overrides
  for (const [key, override] of overrides) {
    const persistedPinned = persistedPinStates.get(key)
    if (persistedPinned === undefined) continue
    const reconciled = reconcileRuntimeTaskPinOverride(override, persistedPinned, revision)
    if (reconciled === override) continue
    if (next === overrides) next = new Map(overrides)
    if (reconciled) {
      next.set(key, reconciled)
    } else {
      next.delete(key)
    }
  }
  return next
}

type OpenSettingsOptions = DesktopSidebarAccountSettingsOptions

type ProjectCreateMenuPosition = {
  top: number
  left: number
}

type RuntimeTaskPriorityReason = 'active' | 'unread' | 'waiting'

interface RuntimePriorityTaskItem {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  projectName: string | null
  projectStateDeviceId: string | null
  isStandaloneChat: boolean
  reason: RuntimeTaskPriorityReason | null
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

const RUNTIME_ARCHIVE_UNDO_DELAY_MS = 3000
const EMPTY_RUNTIME_TASK_KEYS: ReadonlySet<string> = new Set()
const EMPTY_SPLIT_GROUP_MEMBERSHIPS: Readonly<Record<string, WorkbenchSplitGroupMembership>> = {}
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
function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name?.trim() || ''
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

/**
 * Whether any project or chat already represents the workspace path.
 *
 * The standalone row must not duplicate a workspace that is already visible
 * under another device route: the same path can be opened as both a local and
 * an aliased cloud project, and the workbench deduplicates them into one row.
 */
function runtimeWorkHasWorkspace(
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

function standaloneRuntimeProjectWork(
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
const SIDEBAR_HEADER_ICON_BUTTON_CLASS =
  'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] active:bg-[rgb(var(--color-sidebar-active))]'

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

function isSidebarDeviceOnline(deviceState: SidebarDeviceState | null): boolean {
  return !deviceState || deviceState.status === 'online'
}

function getSidebarDeviceName(deviceState: SidebarDeviceState): string {
  return deviceState.device?.name.trim() || ''
}

function hasCloudRuntimeRoute(device?: DeviceInfo): boolean {
  return Boolean(
    device?.runtime_routes?.some(
      route => route.kind === 'cloud-relay' || route.kind === 'remote-relay'
    )
  )
}

function getDeviceRouteLabel(deviceState: SidebarDeviceState): string {
  const deviceName = deviceState.device?.name?.trim()
  if (deviceName) return deviceName
  return ''
}

function getDeviceRouteTitle(deviceState: SidebarDeviceState): string {
  const routes = deviceState.device?.runtime_routes
  if (!routes?.length) return getDeviceRouteLabel(deviceState)
  return routes.map(route => `${route.kind}: ${route.device_id}`).join('\n')
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
    deviceId: workspace.deviceId,
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

function getRuntimeTaskPriorityReason(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary,
  unreadTaskKeys: ReadonlySet<string>,
  runningTaskKeys: ReadonlySet<string>
): RuntimeTaskPriorityReason | null {
  if (unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))) return 'unread'
  if (isRuntimeTaskWaiting(task)) return 'waiting'
  const address = getRuntimeTaskAddress(workspace, task)
  if (runningTaskKeys.has(getRuntimeTaskLifecycleKey(address))) return 'active'
  return null
}

function getRuntimeTaskPriorityRank(reason: RuntimeTaskPriorityReason): number {
  switch (reason) {
    case 'unread':
      return 0
    case 'waiting':
      return 1
    case 'active':
      return 2
  }
}

function getRuntimeTaskSplitGroup(
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

function getRuntimeTaskPriorityTime(task: RuntimeTaskSummary): number {
  const value = getRuntimeTaskTime(task)
  if (value === undefined) return 0
  const numeric = typeof value === 'number' ? value : Number(value)
  const timestamp = Number.isFinite(numeric) ? numeric : new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function getRuntimePriorityTaskKey(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): string {
  return `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
}

function getProjectHoverSources(
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
  cloudStatus?: CloudConnectionStatus
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
  if (cloudStatus === 'restoring' || cloudStatus === 'connecting') {
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
  const connecting = cloud.status === 'restoring' || cloud.status === 'connecting'
  const requiresCloudLogin = !cloud.isConnected
  const needsSession = cloud.isConnected && !targetLabel
  const notifying = enabled && cloud.isConnected && Boolean(targetLabel)
  const cloudConnectionError = cloud.status === 'error' || cloud.status === 'expired'
  const cloudConnectionErrorMessage = cloudConnectionError ? cloud.error : null
  const NotificationIcon = notifying ? MessageCircle : MessageCircleOff
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
                    '锁屏或 Wework 未聚焦时，任务进展会推送到 IM，不会改变任务的 IM 会话归属。'
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
                  className="h-8 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
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

function SidebarReleaseNotesCard({
  releaseNotes,
  onOpen,
  onDismiss,
}: {
  releaseNotes: WeworkInstalledReleaseNotes
  onOpen: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation('common')
  const dismissLabel = t('workbench.app_release_notes_dismiss', '关闭版本更新提示')

  return (
    <aside
      data-testid="sidebar-release-notes-card"
      className="relative mb-1 shrink-0 overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm"
    >
      <button
        type="button"
        data-testid="sidebar-release-notes-open"
        onClick={onOpen}
        className="block w-full py-3 pl-3 pr-10 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="min-w-0 truncate text-sm font-medium">
            {t('workbench.app_release_notes_updated', {
              defaultValue: 'Wework 已更新至 v{{version}}',
              version: releaseNotes.version,
            })}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-4 text-text-secondary">
          {t('workbench.app_release_notes_summary', '查看此版本的新功能和改进')}
        </span>
      </button>
      <button
        type="button"
        data-testid="sidebar-release-notes-dismiss"
        aria-label={dismissLabel}
        title={dismissLabel}
        onClick={onDismiss}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </aside>
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
    t('workbench.project_chat_device_unavailable', '设备{{status}}，无法私信 AI：{{device}}'),
    { status, device: getSidebarDeviceName(deviceState) }
  )
}

function RuntimeTaskRow({
  workspace,
  devices,
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
  priorityReason,
  priorityLayout = false,
  statusInIndent = false,
  splitGroup,
}: {
  workspace: RuntimeDeviceWorkspace
  devices: DeviceInfo[]
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
  priorityReason?: RuntimeTaskPriorityReason
  priorityLayout?: boolean
  statusInIndent?: boolean
  splitGroup?: WorkbenchSplitGroupMembership
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
  const [forceStarting, setForceStarting] = useState(false)
  const [queueReordering, setQueueReordering] = useState(false)
  const workbench = useContext(WorkbenchContext)
  const [taskMenuPosition, setTaskMenuPosition] = useState<ProjectCreateMenuPosition | null>(null)
  const archiveDelayRef = useRef<number | null>(null)
  const titleShimmerDelayRef = useRef<number | null>(null)
  const previousTitleRef = useRef(task.title)
  const [titleShimmering, setTitleShimmering] = useState(false)
  const worktreeTask = isRuntimeWorktreeTask(task)
  const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
  const projectLabel = projectName?.trim() || t('workbench.task')
  const repositoryLabel = getRuntimeTaskRepositoryLabel(workspace, task)
  const branchLabel = getRuntimeTaskBranch(task)
  const taskWorkspacePath = task.workspacePath || workspace.workspacePath
  const taskDevice = getSidebarDeviceState(workspace.deviceId, devices)?.device
  const hostLabel =
    taskDevice?.device_type === 'local'
      ? t('todo.workflow_execution_local_device', '本机')
      : taskDevice?.name?.trim() || workspace.deviceName?.trim() || null
  const hostId =
    workspace.remoteHostId?.trim() || taskDevice?.device_id?.trim() || workspace.deviceId.trim()
  const deviceColor = getRuntimeWorkspaceDeviceColor(workspace)
  const disabled = !workspace.available || !onOpenRuntimeTask
  const splitGroupLabel = splitGroup
    ? t('workbench.split_group_badge', '分屏 {{number}}', {
        number: splitGroup.displayNumber,
      })
    : null
  const archiveDisabled =
    !workspace.available || !onArchiveRuntimeTask || archiving || archivePending
  const taskAddress = getRuntimeTaskAddress(workspace, task)
  const taskLifecycle = useRuntimeTaskLifecycle(taskAddress)
  const queuePaused = useRuntimeTaskQueuePaused(taskAddress)
  const queued = isRuntimeTaskQueued(task)
  const queuePosition =
    queued && Number.isInteger(task.queuePosition) && Number(task.queuePosition) > 0
      ? Number(task.queuePosition)
      : null
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
      if (titleShimmerDelayRef.current !== null) {
        window.clearTimeout(titleShimmerDelayRef.current)
      }
    }
  }, [])
  useEffect(() => {
    if (previousTitleRef.current === task.title) return
    previousTitleRef.current = task.title
    setTitleShimmering(true)
    if (titleShimmerDelayRef.current !== null) {
      window.clearTimeout(titleShimmerDelayRef.current)
    }
    titleShimmerDelayRef.current = window.setTimeout(() => {
      titleShimmerDelayRef.current = null
      setTitleShimmering(false)
    }, 760)
  }, [task.title])
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
  const forceStartTask = async () => {
    if (!queued || !workbench || forceStarting) return
    setForceStarting(true)
    try {
      await workbench.forceStartRuntimeTask(taskAddress)
    } catch (forceStartError) {
      console.error('[Wework] Failed to force start queued runtime task', forceStartError)
      workbench.setWorkbenchError(t('workbench.runtime_task_force_start_failed'))
    } finally {
      setForceStarting(false)
    }
  }
  const reorderQueuedTask = async (nextPosition: number) => {
    if (!queued || !workbench || queueReordering) return
    setQueueReordering(true)
    try {
      await workbench.reorderQueuedRuntimeTask({
        ...taskAddress,
        queuePosition: Math.max(1, nextPosition),
      })
    } catch (queueReorderError) {
      console.error('[Wework] Failed to reorder queued runtime task', queueReorderError)
      workbench.setWorkbenchError(t('workbench.runtime_task_queue_reorder_failed'))
    } finally {
      setQueueReordering(false)
    }
  }
  const notificationActionLabel = notificationsSubscribed
    ? t('workbench.unsubscribe_runtime_task_notifications', '取消任务通知')
    : t('workbench.subscribe_runtime_task_notifications', '订阅任务通知')
  const NotificationIcon = notificationsSubscribed ? MessageCircle : MessageCircleOff
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
            hostId={hostId && hostId !== hostLabel ? hostId : null}
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
          aria-current={
            splitGroup?.active
              ? splitGroup.focused
                ? 'page'
                : undefined
              : selected
                ? 'page'
                : undefined
          }
          onClick={event => {
            if (event.detail > 1) return
            handleOpen()
          }}
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
            'group/task relative flex min-w-0 items-center rounded-[10px] pr-2 text-base leading-5',
            priorityLayout ? 'min-h-[48px] py-1.5' : 'h-[30px]',
            indentClassName,
            disabled ? 'cursor-not-allowed opacity-55' : 'cursor-default',
            selected
              ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
              : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]',
            splitGroup?.focused && 'shadow-[inset_2px_0_0_hsl(var(--primary))]',
            (archivePending || archiving) && 'hidden'
          )}
        >
          <DshContributionSlotSurface
            attachedClassName="contents"
            props={{ priorityLayout, statusInIndent, task, workspace }}
            slot={WEWORK_DSH_SLOTS.taskStatus}
          />
          {priorityLayout ? (
            <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
              <span
                data-sidebar-drag-activator
                data-testid={`runtime-local-task-title-${task.taskId}`}
                className={cn(
                  'runtime-task-title relative flex min-w-0 items-center gap-1 truncate',
                  titleShimmering && 'is-updated'
                )}
              >
                {titleShimmering ? (
                  <span
                    aria-hidden="true"
                    className="runtime-task-title-shimmer"
                    data-testid={`runtime-local-task-title-shimmer-${task.taskId}`}
                  />
                ) : null}
                <span data-testid={`runtime-local-task-drag-activator-${task.taskId}`}>
                  {task.title}
                </span>
              </span>
              <span
                data-testid={`runtime-local-task-source-${task.taskId}`}
                className="flex min-w-0 items-center gap-1 text-sm leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]"
              >
                {projectName ? (
                  <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
                ) : (
                  <Laptop className="h-3 w-3 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">
                  {projectName || t('workbench.app_wework', 'Wework')}
                </span>
              </span>
            </span>
          ) : (
            <span
              data-sidebar-drag-activator
              data-testid={`runtime-local-task-title-${task.taskId}`}
              className={cn(
                'runtime-task-title relative min-w-0 flex-1 truncate',
                titleShimmering && 'is-updated'
              )}
            >
              {titleShimmering ? (
                <span
                  aria-hidden="true"
                  className="runtime-task-title-shimmer"
                  data-testid={`runtime-local-task-title-shimmer-${task.taskId}`}
                />
              ) : null}
              <span data-testid={`runtime-local-task-drag-activator-${task.taskId}`}>
                {task.title}
              </span>
            </span>
          )}
          {splitGroup && splitGroupLabel ? (
            <span
              data-testid={`runtime-local-task-split-group-${task.taskId}`}
              data-split-group={splitGroup.groupId}
              data-split-group-active={splitGroup.active ? 'true' : undefined}
              title={splitGroupLabel}
              aria-label={splitGroupLabel}
              className="ml-1 inline-flex h-5 shrink-0 items-center gap-0.5 rounded-md bg-[rgb(var(--color-sidebar-hover))] px-1.5 text-xs font-medium leading-none text-[rgb(var(--color-sidebar-text-secondary))]"
            >
              <Columns2 className="h-3 w-3" aria-hidden="true" />
              <span>{splitGroup.displayNumber}</span>
            </span>
          ) : null}
          <span
            data-testid={`runtime-local-task-trailing-${task.taskId}`}
            className={cn(
              'relative ml-1 flex min-w-[30px] shrink-0 items-center justify-end transition-[width] group-hover/task:w-[68px]',
              priorityLayout ? 'self-stretch' : 'h-[30px]'
            )}
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
                {queued ? (
                  <span
                    data-testid={`runtime-local-task-queued-${task.taskId}`}
                    role="status"
                    title={
                      queuePosition
                        ? `${t('workbench.runtime_task_queued')} · ${t(
                            'workbench.runtime_task_queue_position',
                            'Position {{position}}',
                            { position: queuePosition }
                          )}`
                        : t('workbench.runtime_task_queued')
                    }
                    aria-label={
                      queuePosition
                        ? `${t('workbench.runtime_task_queued')} · ${t(
                            'workbench.runtime_task_queue_position',
                            'Position {{position}}',
                            { position: queuePosition }
                          )}`
                        : t('workbench.runtime_task_queued')
                    }
                    className="flex h-[30px] min-w-[30px] items-center justify-center gap-0.5"
                  >
                    <AlarmClock className="h-3.5 w-3.5 text-[rgb(var(--color-sidebar-text-muted))]" />
                    {queuePosition ? (
                      <span
                        data-testid={`runtime-local-task-queue-position-${task.taskId}`}
                        className="text-xs tabular-nums text-[rgb(var(--color-sidebar-text-muted))]"
                      >
                        {queuePosition}
                      </span>
                    ) : null}
                  </span>
                ) : queuePaused ? (
                  <span
                    data-testid={`runtime-local-task-queue-paused-${task.taskId}`}
                    role="status"
                    title={t('workbench.runtime_task_queue_paused')}
                    aria-label={t('workbench.runtime_task_queue_paused')}
                    className="flex h-[30px] w-[30px] items-center justify-center"
                  >
                    <Pause
                      className="h-3.5 w-3.5 text-[rgb(var(--color-sidebar-text-muted))]"
                      aria-hidden="true"
                    />
                  </span>
                ) : taskLifecycle?.derived.shouldShowSidebarRunning ? (
                  <span
                    data-testid={`runtime-local-task-running-${task.taskId}`}
                    role="status"
                    title={t('workbench.runtime_task_running')}
                    aria-label={t('workbench.runtime_task_running')}
                    className="flex h-[30px] w-[30px] items-center justify-center"
                  >
                    <CompositedSpinner
                      icon={Loader2}
                      className="h-4 w-4 text-[rgb(var(--color-sidebar-text-muted))]"
                    />
                  </span>
                ) : priorityReason === 'waiting' ? (
                  <span
                    data-testid={`runtime-local-task-waiting-${task.taskId}`}
                    role="status"
                    title={t('workbench.priority_filter_waiting', '等待回复')}
                    aria-label={t('workbench.priority_filter_waiting', '等待回复')}
                    className="flex h-[30px] w-[30px] items-center justify-center"
                  >
                    {priorityLayout ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                    ) : (
                      <Bell className="h-3.5 w-3.5 text-[rgb(var(--color-sidebar-text-muted))]" />
                    )}
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
              className={cn(
                'pointer-events-none absolute right-0 top-1/2 z-[70] flex -translate-y-1/2 items-center justify-end gap-1 opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
                queued ? 'w-[96px]' : 'w-[72px]'
              )}
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
              {queued ? (
                <>
                  <button
                    type="button"
                    data-testid={`runtime-local-task-queue-up-${task.taskId}`}
                    onClick={event => {
                      event.stopPropagation()
                      void reorderQueuedTask((queuePosition ?? 1) - 1)
                    }}
                    disabled={
                      !workspace.available ||
                      !workbench ||
                      queueReordering ||
                      queuePosition === null ||
                      queuePosition <= 1
                    }
                    className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                    title={t('workbench.runtime_task_queue_move_up')}
                    aria-label={t('workbench.runtime_task_queue_move_up')}
                  >
                    <ArrowUp className="h-[15px] w-[15px]" />
                  </button>
                  <button
                    type="button"
                    data-testid={`runtime-local-task-queue-down-${task.taskId}`}
                    onClick={event => {
                      event.stopPropagation()
                      void reorderQueuedTask((queuePosition ?? 1) + 1)
                    }}
                    disabled={
                      !workspace.available ||
                      !workbench ||
                      queueReordering ||
                      queuePosition === null
                    }
                    className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                    title={t('workbench.runtime_task_queue_move_down')}
                    aria-label={t('workbench.runtime_task_queue_move_down')}
                  >
                    <ArrowDown className="h-[15px] w-[15px]" />
                  </button>
                  <button
                    type="button"
                    data-testid={`runtime-local-task-force-start-${task.taskId}`}
                    onClick={event => {
                      event.stopPropagation()
                      void forceStartTask()
                    }}
                    disabled={!workspace.available || !workbench || forceStarting}
                    className="flex h-5 w-5 items-center justify-center text-[rgb(var(--color-sidebar-text-muted))] hover:text-[rgb(var(--color-sidebar-text-primary))] disabled:cursor-not-allowed disabled:opacity-45"
                    title={t('workbench.runtime_task_force_start')}
                    aria-label={t('workbench.runtime_task_force_start')}
                  >
                    {forceStarting ? (
                      <RotateCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-[15px] w-[15px]" />
                    )}
                  </button>
                </>
              ) : (
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
              )}
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
          ...(queued
            ? [
                {
                  label: t('workbench.runtime_task_force_start'),
                  icon: Sparkles,
                  testId: `runtime-local-task-menu-force-start-${task.taskId}`,
                  disabled: !workspace.available || !workbench || forceStarting,
                  onSelect: forceStartTask,
                },
                {
                  label: t('workbench.runtime_task_queue_move_first'),
                  icon: ArrowUp,
                  testId: `runtime-local-task-menu-queue-first-${task.taskId}`,
                  disabled:
                    !workspace.available ||
                    !workbench ||
                    queueReordering ||
                    queuePosition === null ||
                    queuePosition <= 1,
                  onSelect: () => reorderQueuedTask(1),
                },
                {
                  label: t('workbench.runtime_task_queue_move_up'),
                  icon: ArrowUp,
                  testId: `runtime-local-task-menu-queue-up-${task.taskId}`,
                  disabled:
                    !workspace.available ||
                    !workbench ||
                    queueReordering ||
                    queuePosition === null ||
                    queuePosition <= 1,
                  onSelect: () => reorderQueuedTask((queuePosition ?? 1) - 1),
                },
                {
                  label: t('workbench.runtime_task_queue_move_down'),
                  icon: ArrowDown,
                  testId: `runtime-local-task-menu-queue-down-${task.taskId}`,
                  disabled:
                    !workspace.available || !workbench || queueReordering || queuePosition === null,
                  onSelect: () => reorderQueuedTask((queuePosition ?? 1) + 1),
                },
              ]
            : []),
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
            className="electron-titlebar-interactive-region pointer-events-auto fixed left-1/2 top-5 z-[200] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-text-primary shadow-lg"
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

function useRuntimeTaskQueuePaused(address: RuntimeTaskAddress): boolean {
  const stableAddress = useMemo<RuntimeTaskAddress>(
    () => ({
      deviceId: address.deviceId,
      taskId: address.taskId,
    }),
    [address.deviceId, address.taskId]
  )
  const subscribe = useCallback(
    (listener: () => void) => subscribeRuntimeConversation(stableAddress, listener),
    [stableAddress]
  )
  const getSnapshot = useCallback(
    () => getRuntimeConversationQueuePaused(stableAddress),
    [stableAddress]
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function LocalHarnessSessionRow({
  session,
  selected,
  indentClassName,
  onOpen,
  onClose,
}: {
  session: LocalHarnessWorkbenchSession
  selected: boolean
  indentClassName?: string
  onOpen?: (sessionId: string) => void
  onClose?: (sessionId: string) => void | Promise<void>
}) {
  const { t } = useTranslation('common')
  const canArchive = session.harnessId === 'opencode'
  const canClose = !session.isPrimary
  const useArchiveTestId = canArchive && session.isPrimary

  return (
    <div className="group/harness-session relative flex items-center">
      <button
        type="button"
        data-testid={`local-harness-session-row-${session.sessionId}`}
        onClick={() => onOpen?.(session.sessionId)}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2.5 text-left text-sm',
          indentClassName,
          selected
            ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
            : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
        )}
      >
        <SquareTerminal className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{session.title}</span>
      </button>
      {onClose && (canArchive || canClose) && (
        <button
          type="button"
          data-testid={
            useArchiveTestId
              ? `archive-local-harness-session-${session.sessionId}`
              : `close-local-harness-session-${session.sessionId}`
          }
          onClick={event => {
            event.stopPropagation()
            void onClose(session.sessionId)
          }}
          aria-label={
            canArchive
              ? t('workbench.archive_harness', '归档编码会话')
              : t('workbench.close_harness', '关闭编码工具')
          }
          className="absolute right-1 flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] opacity-0 hover:bg-[rgb(var(--color-sidebar-hover))] group-hover/harness-session:opacity-100 focus-visible:opacity-100"
        >
          {canArchive ? <Archive className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  )
}

function ProjectItem({
  project,
  expanded,
  localHarnessSessions,
  activeLocalHarnessSessionId,
  onToggleProject,
  devices,
  runtimeProjectWork,
  currentRuntimeTask,
  splitGroupMemberships,
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
  onOpenLocalHarnessSession,
  onCloseLocalHarnessSession,
}: {
  project: ProjectWithTasks
  expanded: boolean
  localHarnessSessions: LocalHarnessWorkbenchSession[]
  activeLocalHarnessSessionId: string | null
  onToggleProject: (projectId: number) => void
  devices: DeviceInfo[]
  runtimeProjectWork?: RuntimeProjectWork
  currentRuntimeTask?: RuntimeTaskAddress | null
  splitGroupMemberships: Readonly<Record<string, WorkbenchSplitGroupMembership>>
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
  onRenameProject: (project: ProjectWithTasks, projectWork?: RuntimeProjectWork) => void
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
  onOpenLocalHarnessSession?: (sessionId: string) => void
  onCloseLocalHarnessSession?: (sessionId: string) => void | Promise<void>
}) {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
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
    () =>
      getVisibleRuntimeSidebarTaskItems(
        prioritizedRuntimeTaskItems,
        runtimeTaskVisibleLimit,
        currentRuntimeTask?.taskId,
        ({ workspace, task }) =>
          lifecycleSnapshot.runningTaskKeys.has(
            getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
          )
      ),
    [
      currentRuntimeTask?.taskId,
      lifecycleSnapshot.runningTaskKeys,
      prioritizedRuntimeTaskItems,
      runtimeTaskVisibleLimit,
    ]
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
        .filter(
          item =>
            !visibleRuntimeTaskItems.some(
              visibleItem => visibleItem.task.taskId === item.task.taskId
            )
        )
        .map(item => item.task.taskId),
    }
    debugRuntimeSidebarState('project-visible-items', details)
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
      : t('workbench.new_project_chat', '私信 AI')
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
    devices,
    t('todo.workflow_execution_local_device', '本机'),
    finderWorkspacePath,
    path => {
      void openLocalWorkspace({ opener: 'file-manager', path })
    },
    path =>
      formatSidebarTemplate(t('workbench.open_project_source'), {
        source: shortenSidebarHomePath(path),
      })
  )
  const projectActiveTaskCount = allRuntimeTaskItems.filter(({ workspace, task }) =>
    lifecycleSnapshot.runningTaskKeys.has(
      getRuntimeTaskLifecycleKey(getRuntimeTaskAddress(workspace, task))
    )
  ).length
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
    try {
      await onSetRuntimeProjectAppearance({
        deviceId: projectStateDeviceId,
        projectKey,
        appearance: { ...projectAppearance, color },
      })
    } catch (error) {
      console.error('[Wework] Failed to update project appearance', error)
      workbench?.setWorkbenchError(
        error instanceof Error ? error.message : t('workbench.change_project_appearance')
      )
    }
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
            data-sidebar-drag-activator
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
              data-testid={`project-drag-activator-${project.id}`}
              className="flex min-w-0 max-w-full items-center gap-2.5"
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
                    open={expanded}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                )}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
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
            </span>
          </button>
          {showProjectDeviceStatus && (
            <ProjectDeviceInlineStatus
              deviceState={projectDeviceState}
              testId={`project-device-status-${project.id}`}
              className="pointer-events-auto absolute right-2 top-1/2 max-w-[124px] -translate-y-1/2 justify-end text-right transition-opacity group-hover/project:opacity-0 group-focus-within/project:opacity-0"
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
                  label:
                    runtimeProjectWork?.project.stateDeviceId === sidebarStateDeviceId &&
                    runtimeProjectWork?.project.source !== 'remote_project'
                      ? t('workbench.edit_project', '编辑项目')
                      : t('workbench.rename_project', '重命名项目'),
                  icon: Edit3,
                  testId:
                    runtimeProjectWork?.project.stateDeviceId === sidebarStateDeviceId &&
                    runtimeProjectWork?.project.source !== 'remote_project'
                      ? `edit-project-${project.id}`
                      : `rename-project-${project.id}`,
                  onSelect: () => onRenameProject(project, runtimeProjectWork),
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
                        label: fileManagerRevealLabel(t),
                        icon: FolderOpen,
                        testId: `show-project-in-finder-${project.id}`,
                        onSelect: () =>
                          openLocalWorkspace({
                            opener: 'file-manager',
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
        className={cn(!expanded && 'hidden')}
      >
        <div>
          <div className="space-y-0.5">
            {runtimeTaskItems.length === 0 && localHarnessSessions.length === 0 ? (
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
                  getExternalDragData={({ workspace, task }) => ({
                    paneKey: getWorkbenchPaneKey({
                      currentRuntimeTask: {
                        deviceId: workspace.deviceId,
                        taskId: task.taskId,
                      },
                      currentProject: null,
                    }),
                    title: task.title,
                  })}
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
                      devices={devices}
                      task={task}
                      projectName={runtimeProjectWork?.project.name ?? project.name}
                      selected={
                        getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)?.active ||
                        isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
                      }
                      splitGroup={getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)}
                      unread={unreadTaskKeys.has(getRuntimeTaskReminderItemKey(workspace, task))}
                      marked={task.pinned}
                      indentClassName="pl-9"
                      statusInIndent
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
                {localHarnessSessions.map(session => (
                  <LocalHarnessSessionRow
                    key={session.sessionId}
                    session={session}
                    selected={activeLocalHarnessSessionId === session.sessionId}
                    indentClassName="pl-9"
                    onOpen={onOpenLocalHarnessSession}
                    onClose={onCloseLocalHarnessSession}
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
  gitCloneOperations = [],
  currentRuntimeTask,
  splitGroupMemberships = EMPTY_SPLIT_GROUP_MEMBERSHIPS,
  standaloneDeviceId,
  standaloneWorkspacePath,
  imNotificationSettings,
  unreadRuntimeTaskKeys,
  preferredDeviceId,
  activeItem = 'chat',
  localHarnessSessions = [],
  activeLocalHarnessSessionId = null,
  onNewChat,
  onStartStandaloneChat,
  onOpenLocalHarnessSession,
  onCloseLocalHarnessSession,
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
  onRefreshDevices,
  onOpenStandaloneFolderProject,
  onOpenStandaloneWorkspace,
  onCreatePermanentWorktree,
  onSelectStandaloneDevice,
  onGetRemoteDeviceStartupCommand,
  onUpdateProjectName,
  onUpdateLocalRuntimeProject,
  onRemoveProject,
  onReorderRuntimeProjects,
  onSetRuntimeProjectPinned,
  onSetRuntimeProjectAppearance,
  onReorderRuntimeProjectTasks,
  onSetRuntimeTaskPinned,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onCloneGitRepository,
  onStartGitCloneProject,
  onRetryGitCloneOperation,
  onDismissGitCloneOperation,
  projectSpaceApis,
  models = [],
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
}: DesktopSidebarProps) {
  const localProjectPluginApi = useMemo(() => createLocalCodexPluginApi(), [])
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
  const platform = getPlatform()
  const usesOverlayTitlebar = false
  const isWindowsDesktop = isElectronRuntime() && platform === 'win'
  const appUpdate = useOptionalAppUpdate()
  const installedReleaseNotes = appUpdate?.installedReleaseNotes ?? null
  const experimentalFeaturesEnabled = useExperimentalFeaturesEnabled()
  const registeredSidebarNavigation = useDshSlotEntries<WeworkDshSidebarNavigationItem>(
    WEWORK_DSH_SLOTS.sidebarNavigation
  )
  const sidebarNavigation = useMemo(
    () =>
      [...registeredSidebarNavigation]
        .filter(item => !item.experimental || experimentalFeaturesEnabled)
        .sort((left, right) => (left.order ?? 100) - (right.order ?? 100)),
    [experimentalFeaturesEnabled, registeredSidebarNavigation]
  )

  const storageScope = getDesktopSidebarStorageScope(user)
  const projectsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'projectsExpanded')
  const chatsExpandedStorageKey = getDesktopSidebarStorageKey(storageScope, 'chatsExpanded')
  const priorityPinnedStorageKey = getDesktopSidebarStorageKey(storageScope, 'priorityShowPinned')
  const expandedProjectIdsStorageKey = getDesktopSidebarStorageKey(
    storageScope,
    'expandedProjectIds'
  )
  const storageScopeRef = useRef(storageScope)
  const [releaseNotesDialogOpen, setReleaseNotesDialogOpen] = useState(false)
  const [imNotificationMenuOpen, setImNotificationMenuOpen] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const [archiveSectionMode, setArchiveSectionMode] = useState<'projects' | 'chats' | null>(null)
  const [forceArchiveSectionMode, setForceArchiveSectionMode] = useState<
    'projects' | 'chats' | null
  >(null)
  const [priorityArchiveItems, setPriorityArchiveItems] = useState<
    RuntimePriorityTaskItem[] | null
  >(null)
  const [priorityForceArchiveItems, setPriorityForceArchiveItems] = useState<
    RuntimePriorityTaskItem[] | null
  >(null)
  const [isArchivingProjectSection, setIsArchivingProjectSection] = useState(false)
  const [isArchivingChatSection, setIsArchivingChatSection] = useState(false)
  const [isArchivingPriority, setIsArchivingPriority] = useState(false)
  const [projectCreateDialogOpen, setProjectCreateDialogOpen] = useState(false)
  const [standaloneWorkspaceDialogMode, setStandaloneWorkspaceDialogMode] =
    useState<StandaloneWorkspaceDialogMode | null>(null)
  const [standaloneRemoteDialogIntent, setStandaloneRemoteDialogIntent] =
    useState<StandaloneRemoteDialogIntent>('project')
  const [renamingProject, setRenamingProject] = useState<ProjectWithTasks | null>(null)
  const [editingLocalProject, setEditingLocalProject] = useState<RuntimeProjectWork | null>(null)
  const openProjectEditor = (project: ProjectWithTasks, projectWork?: RuntimeProjectWork) => {
    if (
      projectWork?.project.stateDeviceId === sidebarStateDeviceId &&
      projectWork?.project.source !== 'remote_project' &&
      onUpdateLocalRuntimeProject
    ) {
      setEditingLocalProject(projectWork)
      return
    }
    setRenamingProject(project)
  }
  const [projectsExpanded, setProjectsExpanded] = useState(() =>
    readStoredBoolean(projectsExpandedStorageKey, true)
  )
  const [chatsExpanded, setChatsExpanded] = useState(() =>
    readStoredBoolean(chatsExpandedStorageKey, true)
  )
  const [priorityFilterActive, setPriorityFilterActive] = useState(false)
  const [prioritySession, setPrioritySession] = useState<DesktopSidebarPrioritySession | null>(null)
  const priorityFilterShortcut = useConfiguredKeybinding(TOGGLE_PRIORITY_FILTER_COMMAND)
  const [priorityShowPinned, setPriorityShowPinned] = useState(() =>
    readStoredBoolean(priorityPinnedStorageKey, false)
  )
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() =>
    readStoredNumberSet(expandedProjectIdsStorageKey)
  )
  const [runtimeTaskPinOverrides, setRuntimeTaskPinOverrides] = useState<
    Map<string, RuntimeTaskPinOverride>
  >(() => new Map())
  const runtimeTaskPinRequestIdRef = useRef(0)
  const runtimeTaskPinRequestChainsRef = useRef(new Map<string, Promise<void>>())
  const runtimeTaskPinSnapshotRevisionRef = useRef(0)
  const runtimeTaskPersistedPinStatesRef = useRef(new Map<string, boolean>())
  const [sidebarScrolled, setSidebarScrolled] = useState(false)
  const {
    scrollContainerRef: sidebarWorklistsScrollRef,
    dragOutsideSidebar: paneDragOutsideSidebar,
    preserveLockedScrollPosition,
  } = useSidebarPaneDragScrollLock()
  const visibleUnreadRuntimeTaskKeys = unreadRuntimeTaskKeys ?? EMPTY_RUNTIME_TASK_KEYS
  const lifecycleSnapshot = useRuntimeTaskLifecycleStoreSnapshot()
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
  const sidebarRuntimeProjectSource = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return standaloneProjectWork ? [standaloneProjectWork, ...items] : items
  }, [runtimeWork?.projects, standaloneProjectWork])
  const runtimeTaskPersistedPinStates = useMemo(() => {
    const states = new Map<string, boolean>()
    for (const projectWork of sidebarRuntimeProjectSource) {
      for (const workspace of projectWork.deviceWorkspaces) {
        for (const task of workspace.tasks) {
          const threadId = getRuntimeTaskThreadId(task)
          if (!threadId) continue
          states.set(
            getRuntimeTaskPinOverrideKey(
              projectWork.project.stateDeviceId ?? workspace.deviceId,
              threadId
            ),
            Boolean(task.pinned)
          )
        }
      }
    }
    for (const workspace of runtimeWork?.chats ?? []) {
      for (const task of workspace.tasks) {
        const threadId = getRuntimeTaskThreadId(task)
        if (!threadId) continue
        states.set(getRuntimeTaskPinOverrideKey(workspace.deviceId, threadId), Boolean(task.pinned))
      }
    }
    return states
  }, [runtimeWork?.chats, sidebarRuntimeProjectSource])
  useEffect(() => {
    const revision = ++runtimeTaskPinSnapshotRevisionRef.current
    runtimeTaskPersistedPinStatesRef.current = runtimeTaskPersistedPinStates
    setRuntimeTaskPinOverrides(current =>
      reconcileRuntimeTaskPinOverrides(current, runtimeTaskPersistedPinStates, revision)
    )
  }, [runtimeTaskPersistedPinStates])
  const sidebarRuntimeProjects = useMemo(
    () =>
      sidebarRuntimeProjectSource.map(projectWork => ({
        ...projectWork,
        deviceWorkspaces: projectWork.deviceWorkspaces.map(workspace => ({
          ...workspace,
          tasks: workspace.tasks.map(task => {
            const threadId = getRuntimeTaskThreadId(task)
            const persistedPinned = Boolean(task.pinned)
            const override = threadId
              ? runtimeTaskPinOverrides.get(
                  getRuntimeTaskPinOverrideKey(
                    projectWork.project.stateDeviceId ?? workspace.deviceId,
                    threadId
                  )
                )
              : undefined
            const pinned = getRuntimeTaskPinnedValue(persistedPinned, override)
            return pinned === persistedPinned ? task : { ...task, pinned }
          }),
        })),
      })),
    [runtimeTaskPinOverrides, sidebarRuntimeProjectSource]
  )
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
  const sidebarProjectIds = useMemo(
    () => new Set(sidebarProjects.map(project => project.id)),
    [sidebarProjects]
  )
  const standaloneLocalHarnessSessions = useMemo(
    () =>
      localHarnessSessions.filter(
        session => session.projectId === null || !sidebarProjectIds.has(session.projectId)
      ),
    [localHarnessSessions, sidebarProjectIds]
  )
  const localHarnessSessionsByProjectId = useMemo(() => {
    const sessionsByProjectId = new Map<number, LocalHarnessWorkbenchSession[]>()
    for (const session of localHarnessSessions) {
      if (session.projectId === null || !sidebarProjectIds.has(session.projectId)) continue
      const sessions = sessionsByProjectId.get(session.projectId) ?? []
      sessions.push(session)
      sessionsByProjectId.set(session.projectId, sessions)
    }
    return sessionsByProjectId
  }, [localHarnessSessions, sidebarProjectIds])
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
          ? runtimeTaskPinOverrides.get(
              getRuntimeTaskPinOverrideKey(item.workspace.deviceId, threadId)
            )
          : undefined
        const pinned = getRuntimeTaskPinnedValue(persistedPinned, override)
        return pinned === persistedPinned ? item : { ...item, task: { ...item.task, pinned } }
      }),
    [chatTaskItems, runtimeTaskPinOverrides]
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
  const allPriorityViewTaskItems = useMemo<RuntimePriorityTaskItem[]>(() => {
    const projectTasks = sidebarRuntimeProjects.flatMap(projectWork =>
      getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).map(({ workspace, task }) => ({
        workspace,
        task,
        projectName: projectWork.project.name,
        projectStateDeviceId: projectWork.project.stateDeviceId ?? workspace.deviceId,
        isStandaloneChat: false,
        reason: getRuntimeTaskPriorityReason(
          workspace,
          task,
          visibleUnreadRuntimeTaskKeys,
          lifecycleSnapshot.runningTaskKeys
        ),
      }))
    )
    const standaloneChatTasks = chatTaskItemsWithPinState.map(({ workspace, task }) => ({
      workspace,
      task,
      projectName: null,
      projectStateDeviceId: workspace.deviceId,
      isStandaloneChat: true,
      reason: getRuntimeTaskPriorityReason(
        workspace,
        task,
        visibleUnreadRuntimeTaskKeys,
        lifecycleSnapshot.runningTaskKeys
      ),
    }))

    return [...projectTasks, ...standaloneChatTasks]
  }, [
    chatTaskItemsWithPinState,
    lifecycleSnapshot.runningTaskKeys,
    sidebarRuntimeProjects,
    visibleUnreadRuntimeTaskKeys,
  ])
  const priorityViewSources = useMemo<DesktopSidebarPrioritySource<RuntimePriorityTaskItem>[]>(
    () =>
      allPriorityViewTaskItems.map(item => ({
        key: getRuntimePriorityTaskKey(item.workspace, item.task),
        item,
        pinned: Boolean(item.task.pinned),
        pinnedOrder: item.task.pinnedOrder ?? Number.MAX_SAFE_INTEGER,
        priorityRank: item.reason === null ? null : getRuntimeTaskPriorityRank(item.reason),
        recencyAt: getRuntimeTaskPriorityTime(item.task),
      })),
    [allPriorityViewTaskItems]
  )
  const livePriorityTaskItems = useMemo(
    () =>
      allPriorityViewTaskItems
        .filter(item => item.reason !== null)
        .sort(
          (left, right) =>
            getRuntimeTaskPriorityRank(left.reason!) - getRuntimeTaskPriorityRank(right.reason!) ||
            getRuntimeTaskPriorityTime(right.task) - getRuntimeTaskPriorityTime(left.task)
        ),
    [allPriorityViewTaskItems]
  )
  const priorityNeedsAttention = livePriorityTaskItems.length > 0
  let currentPrioritySession = prioritySession
  if (priorityFilterActive && currentPrioritySession) {
    const reconciledSession = reconcileDesktopSidebarPrioritySession(
      currentPrioritySession,
      priorityViewSources,
      priorityShowPinned
    )
    if (reconciledSession !== currentPrioritySession) {
      currentPrioritySession = reconciledSession
      setPrioritySession(reconciledSession)
    }
  }
  const priorityView = currentPrioritySession
    ? selectDesktopSidebarPriorityView(
        currentPrioritySession,
        priorityViewSources,
        priorityShowPinned
      )
    : {
        pinnedItems: [],
        priorityItems: livePriorityTaskItems,
        recentGroups: [],
      }
  const togglePriorityFilter = useCallback(() => {
    if (priorityFilterActive) {
      setPriorityFilterActive(false)
      setPrioritySession(null)
      return
    }
    setPrioritySession(createDesktopSidebarPrioritySession(priorityViewSources, priorityShowPinned))
    setPriorityFilterActive(true)
  }, [
    priorityFilterActive,
    priorityShowPinned,
    priorityViewSources,
    setPriorityFilterActive,
    setPrioritySession,
  ])

  const unreadPriorityTaskItems = useMemo(
    () =>
      priorityView.priorityItems.filter(item =>
        visibleUnreadRuntimeTaskKeys.has(getRuntimeTaskReminderItemKey(item.workspace, item.task))
      ),
    [priorityView.priorityItems, visibleUnreadRuntimeTaskKeys]
  )
  const markAllPriorityTasksRead = () => {
    if (!onMarkRuntimeTaskRead) return
    for (const item of unreadPriorityTaskItems) {
      onMarkRuntimeTaskRead(getRuntimeTaskAddress(item.workspace, item.task))
    }
  }
  const openPriorityArchiveDialog = () => {
    if (!onArchiveRuntimeTask || priorityView.priorityItems.length === 0) return
    setPriorityArchiveItems(priorityView.priorityItems)
  }
  const runPriorityArchive = async (
    items: RuntimePriorityTaskItem[],
    options?: ArchiveRuntimeTaskOptions
  ) => {
    if (!onArchiveRuntimeTask || items.length === 0) return
    setIsArchivingPriority(true)
    const dirtyItems: RuntimePriorityTaskItem[] = []
    try {
      for (const item of items) {
        try {
          const result = await onArchiveRuntimeTask(
            getRuntimeTaskAddress(item.workspace, item.task),
            options
          )
          if (!options?.force && result?.status === 'dirty_worktree') {
            dirtyItems.push(item)
          }
        } catch (error) {
          console.error('Failed to archive priority task', error)
        }
      }
      setPriorityArchiveItems(null)
      setPriorityForceArchiveItems(dirtyItems.length > 0 ? dirtyItems : null)
    } finally {
      setIsArchivingPriority(false)
    }
  }
  const closePriorityArchiveDialog = () => {
    if (!isArchivingPriority) setPriorityArchiveItems(null)
  }
  const closePriorityForceArchiveDialog = () => {
    if (!isArchivingPriority) setPriorityForceArchiveItems(null)
  }

  const setRuntimeTaskPinnedOptimistically = async (data: RuntimeTaskPinRequest) => {
    if (!onSetRuntimeTaskPinned) return
    const projectTask = sidebarRuntimeProjectSource
      .flatMap(projectWork =>
        getRuntimeSidebarTaskItems(projectWork.deviceWorkspaces).map(item => ({
          ...item,
          stateDeviceId: projectWork.project.stateDeviceId ?? item.workspace.deviceId,
        }))
      )
      .find(
        ({ stateDeviceId, task }) =>
          stateDeviceId === data.deviceId && getRuntimeTaskThreadId(task) === data.threadId
      )
    const runtimeTask =
      projectTask ??
      chatTaskItems.find(
        ({ workspace, task }) =>
          workspace.deviceId === data.deviceId && getRuntimeTaskThreadId(task) === data.threadId
      )
    if (!runtimeTask) {
      await onSetRuntimeTaskPinned(data)
      return
    }

    const key = getRuntimeTaskPinOverrideKey(data.deviceId, data.threadId)
    const requestId = ++runtimeTaskPinRequestIdRef.current
    setRuntimeTaskPinOverrides(current => {
      const next = new Map(current)
      const existing = current.get(key)
      next.set(key, {
        mutations: [
          ...(existing?.mutations ?? []),
          {
            createdRevision: runtimeTaskPinSnapshotRevisionRef.current,
            requestId,
            status: 'pending',
            value: data.pinned,
          },
        ],
      })
      return next
    })
    const previousRequest = runtimeTaskPinRequestChainsRef.current.get(key) ?? Promise.resolve()
    const request = previousRequest.catch(() => undefined).then(() => onSetRuntimeTaskPinned(data))
    runtimeTaskPinRequestChainsRef.current.set(key, request)
    try {
      await request
      setRuntimeTaskPinOverrides(current => {
        const override = current.get(key)
        if (!override) return current
        const mutations = override.mutations.map(mutation =>
          mutation.requestId === requestId
            ? { ...mutation, status: 'succeeded' as const }
            : mutation
        )
        const persistedPinned = runtimeTaskPersistedPinStatesRef.current.get(key)
        const reconciled =
          persistedPinned === undefined
            ? { mutations }
            : reconcileRuntimeTaskPinOverride(
                { mutations },
                persistedPinned,
                runtimeTaskPinSnapshotRevisionRef.current
              )
        const next = new Map(current)
        if (reconciled) {
          next.set(key, reconciled)
        } else {
          next.delete(key)
        }
        return next
      })
    } catch (error) {
      setRuntimeTaskPinOverrides(current => {
        const override = current.get(key)
        if (!override?.mutations.some(mutation => mutation.requestId === requestId)) return current
        const next = new Map(current)
        const mutations = override.mutations.filter(mutation => mutation.requestId !== requestId)
        if (mutations.length > 0) {
          next.set(key, { mutations })
        } else {
          next.delete(key)
        }
        return next
      })
      throw error
    } finally {
      if (runtimeTaskPinRequestChainsRef.current.get(key) === request) {
        runtimeTaskPinRequestChainsRef.current.delete(key)
      }
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
    const activeHarnessProjectId = localHarnessSessions.find(
      session => session.sessionId === activeLocalHarnessSessionId
    )?.projectId
    if (activeHarnessProjectId) {
      return {
        autoExpandKey: `harness:${activeLocalHarnessSessionId}`,
        id: activeHarnessProjectId,
      }
    }

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
  }, [
    activeLocalHarnessSessionId,
    currentRuntimeTask,
    localHarnessSessions,
    sidebarRuntimeProjects,
    standaloneDeviceId,
    standaloneWorkspacePath,
  ])
  const selectedRuntimeProjectId = selectedRuntimeProject?.id ?? null
  const selectedRuntimeProjectAutoExpandKey = selectedRuntimeProject?.autoExpandKey ?? null
  const selectedRuntimeChatVisible = useMemo(() => {
    if (!currentRuntimeTask) return false
    return regularChatTaskItems.some(({ workspace, task }) =>
      isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
    )
  }, [currentRuntimeTask, regularChatTaskItems])
  const displayedProjectsExpanded = projectsExpanded
  const runtimeWorkCheck = cloudWorkStatus?.checks.runtimeWork
  const showEmptyProjectCreateAction =
    runtimeWork !== null &&
    runtimeWork !== undefined &&
    runtimeWorkCheck !== null &&
    runtimeWorkCheck !== undefined &&
    runtimeWorkCheck !== 'syncing' &&
    sidebarProjects.length === 0
  const displayedChatsExpanded =
    chatsExpanded ||
    selectedRuntimeChatVisible ||
    standaloneLocalHarnessSessions.some(
      session => session.sessionId === activeLocalHarnessSessionId
    )
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
  const currentRuntimeTaskKey = currentRuntimeTask
    ? getRuntimeNotificationKey(currentRuntimeTask)
    : null
  const currentRuntimeTaskPinned = useMemo(
    () =>
      Boolean(
        currentRuntimeTask &&
        pinnedTaskItems.some(({ workspace, task }) =>
          isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
        )
      ),
    [currentRuntimeTask, pinnedTaskItems]
  )
  const currentRuntimeTaskRowVisible = Boolean(
    currentRuntimeTaskKey &&
    (currentRuntimeTaskPinned ||
      (selectedRuntimeProjectId !== null &&
        displayedProjectsExpanded &&
        displayedExpandedProjectIds.has(selectedRuntimeProjectId)) ||
      (selectedRuntimeChatVisible && displayedChatsExpanded))
  )
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
    if (!imNotificationMenuOpen) return

    const handleOutsidePointer = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
      if (!settingsMenuRef.current?.contains(event.target as Node)) {
        setImNotificationMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsidePointer)
    document.addEventListener('mousedown', handleOutsidePointer)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      document.removeEventListener('mousedown', handleOutsidePointer)
    }
  }, [imNotificationMenuOpen])

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

  const openProjectCreateDialog = () => {
    setProjectCreateDialogOpen(true)
    void onRefreshDevices?.().catch(() => undefined)
  }

  useEscapeKey(() => setProjectCreateDialogOpen(false), projectCreateDialogOpen)

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
    writeStoredBoolean(priorityPinnedStorageKey, priorityShowPinned)
  }, [priorityPinnedStorageKey, priorityShowPinned, storageScope])

  useEffect(() => {
    if (storageScopeRef.current !== storageScope) return
    writeStoredNumberSet(expandedProjectIdsStorageKey, expandedProjectIds)
  }, [expandedProjectIds, expandedProjectIdsStorageKey, storageScope])

  useEffect(() => {
    if (storageScopeRef.current === storageScope) return

    storageScopeRef.current = storageScope
    setProjectsExpanded(readStoredBoolean(projectsExpandedStorageKey, true))
    setChatsExpanded(readStoredBoolean(chatsExpandedStorageKey, true))
    setPriorityFilterActive(false)
    setPrioritySession(null)
    setPriorityShowPinned(readStoredBoolean(priorityPinnedStorageKey, false))
    setExpandedProjectIds(readStoredNumberSet(expandedProjectIdsStorageKey))
  }, [
    chatsExpandedStorageKey,
    expandedProjectIdsStorageKey,
    priorityPinnedStorageKey,
    projectsExpandedStorageKey,
    storageScope,
  ])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isEditableShortcutTarget(event.target) ||
        !priorityFilterShortcut ||
        keybindingFromKeyboardEvent(event) !== priorityFilterShortcut
      )
        return
      event.preventDefault()
      togglePriorityFilter()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [priorityFilterShortcut, togglePriorityFilter])

  useEffect(() => {
    if (!currentRuntimeTaskKey || !currentRuntimeTaskRowVisible) return

    const taskRow = document.querySelector(
      `[data-testid="runtime-local-task-row-${currentRuntimeTask?.taskId}"]`
    )

    taskRow?.scrollIntoView({ block: 'nearest' })
  }, [currentRuntimeTask?.taskId, currentRuntimeTaskKey, currentRuntimeTaskRowVisible])

  return (
    <aside
      data-testid={containerTestId}
      data-sidebar-translucent={
        isWindowsDesktop && !(background.imagePath && background.inSidebar) ? 'false' : undefined
      }
      aria-hidden={collapsed}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        'relative z-popover h-full shrink-0 overflow-visible transition-[width,background-color] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none will-change-[width]',
        !collapsed && 'border-r border-black/[0.08] dark:border-white/[0.08]',
        background.imagePath && background.inSidebar
          ? 'bg-background/25'
          : 'bg-[rgb(var(--color-sidebar))]',
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
                'absolute inset-x-0 top-0 z-chrome flex h-[38px] items-center justify-between pr-2',
                'pl-[92px]'
              )}
            >
              <DesktopWindowControls
                sidebarCollapsed={false}
                onToggleSidebar={onToggleSidebar}
                className="gap-1"
                buttonClassName={SIDEBAR_HEADER_ICON_BUTTON_CLASS}
              />
            </div>
          )}
          <DesktopSidebarHeader
            actions={
              <>
                {onToggleSidebar && (
                  <DesktopWindowControls
                    sidebarCollapsed={false}
                    onToggleSidebar={onToggleSidebar}
                    className="gap-0"
                    buttonClassName={SIDEBAR_HEADER_ICON_BUTTON_CLASS}
                  />
                )}
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
                <TitlebarTooltip
                  label={
                    priorityFilterActive
                      ? t('workbench.priority_filter_turn_off', '关闭优先级筛选')
                      : t('workbench.priority_filter', '按优先级筛选')
                  }
                  shortcut={
                    priorityFilterActive ? undefined : (priorityFilterShortcut ?? undefined)
                  }
                  align="end"
                  testId="runtime-priority-filter-tooltip"
                >
                  <button
                    type="button"
                    data-testid="runtime-priority-filter-button"
                    onClick={togglePriorityFilter}
                    aria-pressed={priorityFilterActive}
                    className={cn(
                      'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
                      priorityFilterActive && 'bg-[rgb(var(--color-sidebar-active))]'
                    )}
                    aria-label={
                      priorityNeedsAttention && !priorityFilterActive
                        ? t('workbench.priority_filter_needs_attention', '按优先级筛选，需要关注')
                        : priorityFilterActive
                          ? t('workbench.priority_filter_turn_off', '关闭优先级筛选')
                          : t('workbench.priority_filter', '按优先级筛选')
                    }
                  >
                    <Bell className="h-4 w-4" aria-hidden="true" />
                    {priorityNeedsAttention && !priorityFilterActive && (
                      <span
                        data-testid="runtime-priority-filter-attention-dot"
                        aria-hidden="true"
                        className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
                      />
                    )}
                  </button>
                </TitlebarTooltip>
              </>
            }
          />
          <nav className="space-y-0.5">
            <DesktopSidebarNavItem
              icon={Plus}
              label={t('workbench.new_task')}
              testId="new-chat-button"
              onClick={onNewChat}
            />
          </nav>

          <div
            ref={sidebarWorklistsScrollRef}
            data-testid="sidebar-worklists-scroll"
            data-scrolled={sidebarScrolled}
            onScroll={event => {
              if (preserveLockedScrollPosition(event)) return
              setSidebarScrolled(event.currentTarget.scrollTop > 0)
            }}
            className={cn(
              'relative mb-2 mt-0.5 min-h-0 flex-1 border-t border-transparent pb-3 [overflow-anchor:none] [mask-image:linear-gradient(to_bottom,black_0,black_calc(100%_-_16px),transparent_100%)]',
              paneDragOutsideSidebar ? 'overflow-y-hidden' : 'overflow-y-auto',
              sidebarScrolled &&
                'scrollbar-soft border-border [mask-image:linear-gradient(to_bottom,transparent_0,black_12px,black_calc(100%_-_16px),transparent_100%)]',
              !sidebarScrolled && 'scrollbar-none'
            )}
          >
            <nav className="mb-4 space-y-0.5">
              {sidebarNavigation.map(item => {
                if (item.surface === 'module') {
                  return (
                    <DshSidebarNavigationSurface
                      key={item.id}
                      item={item}
                      devices={devices}
                      cloudWorkStatus={cloudWorkStatus}
                      selected={activeItem === (item.activeItem ?? item.id)}
                      onNavigate={navigateTo}
                      onOpenSettings={settingsPage =>
                        onOpenSettings({
                          settingsPage: settingsPage as OpenSettingsOptions['settingsPage'],
                        })
                      }
                      onSelectStandaloneDevice={onSelectStandaloneDevice}
                      onAddRemoteDevice={() => {
                        if (onOpenStandaloneFolderProject) {
                          onOpenStandaloneFolderProject('remote', 'add-device')
                        } else {
                          setStandaloneRemoteDialogIntent('add-device')
                          setStandaloneWorkspaceDialogMode('remote')
                        }
                      }}
                    />
                  )
                }

                return (
                  <DesktopSidebarNavItem
                    key={item.id}
                    iconElement={
                      <DshIcon
                        name={item.icon}
                        aria-hidden="true"
                        className="h-4 w-4 text-current"
                      />
                    }
                    label={t(item.labelKey ?? item.id, item.label)}
                    testId={item.testId ?? `dsh-sidebar-navigation-${item.id}`}
                    selected={activeItem === (item.activeItem ?? item.id)}
                    onClick={() => navigateTo(item.path)}
                    onPointerEnter={
                      item.prefetch ? () => prefetchDshSidebarNavigation(item) : undefined
                    }
                  />
                )
              })}
            </nav>
            {priorityFilterActive ? (
              <DesktopSidebarPrioritySection
                priorityItems={priorityView.priorityItems}
                pinnedItems={priorityView.pinnedItems}
                recentGroups={priorityView.recentGroups}
                getTaskKey={item => getRuntimePriorityTaskKey(item.workspace, item.task)}
                showPinned={priorityShowPinned}
                onTogglePinned={() => setPriorityShowPinned(showPinned => !showPinned)}
                canMarkAllAsRead={
                  Boolean(onMarkRuntimeTaskRead) && unreadPriorityTaskItems.length > 0
                }
                canArchivePriority={
                  Boolean(onArchiveRuntimeTask) && priorityView.priorityItems.length > 0
                }
                onMarkAllAsRead={markAllPriorityTasksRead}
                onArchivePriority={openPriorityArchiveDialog}
                renderTaskItem={item => (
                  <RuntimeTaskRow
                    workspace={item.workspace}
                    devices={devices}
                    task={item.task}
                    projectName={item.projectName}
                    selected={
                      getRuntimeTaskSplitGroup(splitGroupMemberships, item.workspace, item.task)
                        ?.active ||
                      isRuntimeTaskSelected(currentRuntimeTask, item.workspace, item.task)
                    }
                    splitGroup={getRuntimeTaskSplitGroup(
                      splitGroupMemberships,
                      item.workspace,
                      item.task
                    )}
                    unread={visibleUnreadRuntimeTaskKeys.has(
                      getRuntimeTaskReminderItemKey(item.workspace, item.task)
                    )}
                    priorityReason={item.reason ?? undefined}
                    priorityLayout
                    indentClassName="pl-2"
                    imNotificationSettings={imNotificationSettings}
                    showDeviceMarker={false}
                    stateDeviceId={item.projectStateDeviceId}
                    onOpenRuntimeTask={onOpenRuntimeTask}
                    onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                    onRenameRuntimeTask={onRenameRuntimeTask}
                    onArchiveRuntimeTask={onArchiveRuntimeTask}
                    onSetRuntimeTaskPinned={
                      onSetRuntimeTaskPinned ? setRuntimeTaskPinnedOptimistically : undefined
                    }
                    onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                  />
                )}
              />
            ) : (
              <>
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
                        getExternalDragData={({ workspace, task }) => ({
                          paneKey: getWorkbenchPaneKey({
                            currentRuntimeTask: {
                              deviceId: workspace.deviceId,
                              taskId: task.taskId,
                            },
                            currentProject: null,
                          }),
                          title: task.title,
                        })}
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
                            throw new Error(
                              'Pinned tasks from different devices cannot be reordered'
                            )
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
                            devices={devices}
                            task={task}
                            projectName={projectWork?.project.name}
                            selected={
                              getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)
                                ?.active ||
                              isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
                            }
                            splitGroup={getRuntimeTaskSplitGroup(
                              splitGroupMemberships,
                              workspace,
                              task
                            )}
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
                              onSetRuntimeTaskPinned
                                ? setRuntimeTaskPinnedOptimistically
                                : undefined
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
                            localHarnessSessions={
                              localHarnessSessionsByProjectId.get(project.id) ?? []
                            }
                            activeLocalHarnessSessionId={activeLocalHarnessSessionId}
                            devices={devices}
                            runtimeProjectWork={runtimeProjectWork}
                            currentRuntimeTask={currentRuntimeTask}
                            splitGroupMemberships={splitGroupMemberships}
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
                            onSetRuntimeTaskPinned={
                              onSetRuntimeTaskPinned
                                ? setRuntimeTaskPinnedOptimistically
                                : undefined
                            }
                            onRenameProject={openProjectEditor}
                            onOpenRuntimeTask={onOpenRuntimeTask}
                            onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                            onRenameRuntimeTask={onRenameRuntimeTask}
                            onArchiveRuntimeTask={onArchiveRuntimeTask}
                            onArchiveProjectConversations={onArchiveProjectConversations}
                            onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                            onOpenLocalHarnessSession={onOpenLocalHarnessSession}
                            onCloseLocalHarnessSession={onCloseLocalHarnessSession}
                          />
                        )}
                      />
                    )}
                  </section>
                )}
                <section>
                  <div>
                    <DesktopSidebarSectionHeader
                      title={t('workbench.projects', '项目')}
                      expanded={displayedProjectsExpanded}
                      hasContent={sidebarProjects.length > 0 || gitCloneOperations.length > 0}
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
                            openProjectCreateDialog()
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
                          aria-expanded={projectCreateDialogOpen}
                        >
                          <FolderPlus className="h-4 w-4" />
                        </button>
                      </div>
                    </DesktopSidebarSectionHeader>
                  </div>
                  {projectCreateDialogOpen &&
                    createPortal(
                      <div
                        data-testid="project-create-dialog-overlay"
                        className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
                        onClick={event => {
                          if (event.target === event.currentTarget)
                            setProjectCreateDialogOpen(false)
                        }}
                      >
                        <div
                          role="dialog"
                          aria-modal="true"
                          aria-labelledby="project-create-dialog-title"
                          data-testid="projects-create-button-menu"
                          className="w-full max-w-[520px] rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-2xl"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <h2 id="project-create-dialog-title" className="heading-base">
                                {t('workbench.create_project_title', '创建项目')}
                              </h2>
                              <p className="mt-2 text-sm leading-5 text-text-secondary">
                                {t(
                                  'workbench.create_project_description',
                                  '选择项目运行的位置。之后可以在项目中切换工作目录。'
                                )}
                              </p>
                            </div>
                            <button
                              type="button"
                              data-testid="close-project-source-dialog"
                              aria-label={t('workbench.close_dialog', '关闭')}
                              onClick={() => setProjectCreateDialogOpen(false)}
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                          <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            <button
                              type="button"
                              data-testid="project-create-local-option"
                              onClick={() => {
                                setProjectCreateDialogOpen(false)
                                if (onOpenStandaloneFolderProject) {
                                  onOpenStandaloneFolderProject('existing')
                                } else {
                                  setStandaloneWorkspaceDialogMode('existing')
                                }
                              }}
                              className="rounded-xl border border-border bg-background p-4 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                            >
                              <FolderOpen className="h-5 w-5 text-text-primary" />
                              <span className="mt-3 block text-base font-medium">
                                {t('workbench.local_project', '本地项目')}
                              </span>
                              <span className="mt-1 block text-sm leading-5 text-text-secondary">
                                {t(
                                  'workbench.local_project_description',
                                  '选择一个或多个本地文件夹。'
                                )}
                              </span>
                            </button>
                            <button
                              type="button"
                              data-testid="project-create-remote-option"
                              onClick={() => {
                                setProjectCreateDialogOpen(false)
                                if (onOpenStandaloneFolderProject) {
                                  onOpenStandaloneFolderProject('remote', 'project')
                                } else {
                                  setStandaloneRemoteDialogIntent('project')
                                  setStandaloneWorkspaceDialogMode('remote')
                                }
                              }}
                              className="rounded-xl border border-border bg-background p-4 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                            >
                              <Globe2 className="h-5 w-5 text-text-primary" />
                              <span className="mt-3 block text-base font-medium">
                                {t('workbench.cloud_project', '云端项目')}
                              </span>
                              <span className="mt-1 block text-sm leading-5 text-text-secondary">
                                {t(
                                  'workbench.cloud_project_description',
                                  '使用云设备或远程主机上的项目目录。'
                                )}
                              </span>
                            </button>
                          </div>
                        </div>
                      </div>,
                      document.body
                    )}
                  {displayedProjectsExpanded && (
                    <>
                      {showEmptyProjectCreateAction && gitCloneOperations.length === 0 && (
                        <DesktopSidebarNavItem
                          icon={Plus}
                          label={t('workbench.new_project', '新建项目')}
                          testId="projects-empty-create-button"
                          onClick={openProjectCreateDialog}
                        />
                      )}
                      {gitCloneOperations.length > 0 && (
                        <div
                          data-testid="git-clone-project-operations"
                          className="mb-1 space-y-0.5"
                        >
                          {gitCloneOperations.map(operation => (
                            <div
                              key={operation.id}
                              data-testid={`git-clone-project-operation-${operation.id}`}
                              className="flex min-h-[30px] items-center gap-2 rounded-[10px] px-2.5 text-sm text-[rgb(var(--color-sidebar-text-primary))]"
                              title={operation.error || operation.targetPath}
                            >
                              {operation.status !== 'failed' ? (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                              ) : (
                                <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
                              )}
                              <span className="min-w-0 flex-1 truncate">{operation.name}</span>
                              <span className="shrink-0 text-xs text-[rgb(var(--color-sidebar-text-muted))]">
                                {operation.status === 'cloning'
                                  ? t('workbench.remote_project_git_cloning', '克隆中')
                                  : operation.status === 'opening'
                                    ? t('workbench.remote_project_git_opening', '添加中')
                                    : operation.failureReason === 'executor-offline'
                                      ? t('workbench.remote_project_device_offline', '设备离线')
                                      : operation.failureStage === 'open'
                                        ? t('workbench.remote_project_git_open_failed', '添加失败')
                                        : t('workbench.remote_project_git_failed', '克隆失败')}
                              </span>
                              {operation.status === 'failed' && (
                                <>
                                  <button
                                    type="button"
                                    data-testid={`retry-git-clone-project-${operation.id}`}
                                    onClick={() => onRetryGitCloneOperation?.(operation)}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
                                    aria-label={t('workbench.retry', '重试')}
                                  >
                                    <RotateCw className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    data-testid={`dismiss-git-clone-project-${operation.id}`}
                                    onClick={() => onDismissGitCloneOperation?.(operation.id)}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))]"
                                    aria-label={t('workbench.remove', '移除')}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {sidebarProjects.length > 0 && (
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
                              localHarnessSessions={
                                localHarnessSessionsByProjectId.get(project.id) ?? []
                              }
                              activeLocalHarnessSessionId={activeLocalHarnessSessionId}
                              devices={devices}
                              runtimeProjectWork={runtimeProjectWork}
                              currentRuntimeTask={currentRuntimeTask}
                              splitGroupMemberships={splitGroupMemberships}
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
                              onSetRuntimeTaskPinned={
                                onSetRuntimeTaskPinned
                                  ? setRuntimeTaskPinnedOptimistically
                                  : undefined
                              }
                              onRenameProject={openProjectEditor}
                              onOpenRuntimeTask={onOpenRuntimeTask}
                              onMarkRuntimeTaskRead={onMarkRuntimeTaskRead}
                              onRenameRuntimeTask={onRenameRuntimeTask}
                              onArchiveRuntimeTask={onArchiveRuntimeTask}
                              onArchiveProjectConversations={onArchiveProjectConversations}
                              onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                              onOpenLocalHarnessSession={onOpenLocalHarnessSession}
                              onCloseLocalHarnessSession={onCloseLocalHarnessSession}
                            />
                          )}
                        />
                      )}
                    </>
                  )}
                </section>

                <section data-testid="runtime-chat-section" className="mt-8">
                  <DesktopSidebarSectionHeader
                    title={t('workbench.tasks')}
                    expanded={displayedChatsExpanded}
                    hasContent={
                      standaloneLocalHarnessSessions.length > 0 || regularChatTaskItems.length > 0
                    }
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
                  </DesktopSidebarSectionHeader>
                  {displayedChatsExpanded && (
                    <div className="space-y-0.5 pb-2">
                      {standaloneLocalHarnessSessions.length === 0 &&
                      regularChatTaskItems.length === 0 ? (
                        <div
                          data-testid="runtime-chat-empty"
                          className="ml-2 rounded-md px-3 py-1.5 text-xs text-[rgb(var(--color-sidebar-text-muted))]"
                        >
                          {t('workbench.no_chats', '暂无会话')}
                        </div>
                      ) : regularChatTaskItems.length > 0 ? (
                        <SidebarSortableList
                          testId="runtime-chat-task-sortable-list"
                          className="space-y-0.5"
                          items={regularChatTaskItems}
                          getId={({ workspace, task }) =>
                            `${workspace.deviceId}:${getRuntimeTaskThreadId(task) || task.taskId}`
                          }
                          getLabel={({ task }) => task.title}
                          getExternalDragData={({ workspace, task }) => ({
                            paneKey: getWorkbenchPaneKey({
                              currentRuntimeTask: {
                                deviceId: workspace.deviceId,
                                taskId: task.taskId,
                              },
                              currentProject: null,
                            }),
                            title: task.title,
                          })}
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
                            const beforeThreadId = before
                              ? getRuntimeTaskThreadId(before.task)
                              : null
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
                              devices={devices}
                              task={task}
                              projectName={null}
                              selected={
                                getRuntimeTaskSplitGroup(splitGroupMemberships, workspace, task)
                                  ?.active ||
                                isRuntimeTaskSelected(currentRuntimeTask, workspace, task)
                              }
                              splitGroup={getRuntimeTaskSplitGroup(
                                splitGroupMemberships,
                                workspace,
                                task
                              )}
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
                                onSetRuntimeTaskPinned
                                  ? setRuntimeTaskPinnedOptimistically
                                  : undefined
                              }
                              onToggleRuntimeTaskNotification={onToggleRuntimeTaskNotification}
                            />
                          )}
                        />
                      ) : null}
                      {standaloneLocalHarnessSessions.map(session => (
                        <LocalHarnessSessionRow
                          key={session.sessionId}
                          session={session}
                          selected={activeLocalHarnessSessionId === session.sessionId}
                          onOpen={onOpenLocalHarnessSession}
                          onClose={onCloseLocalHarnessSession}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>

          {installedReleaseNotes && (
            <SidebarReleaseNotesCard
              releaseNotes={installedReleaseNotes}
              onOpen={() => setReleaseNotesDialogOpen(true)}
              onDismiss={() => {
                setReleaseNotesDialogOpen(false)
                appUpdate?.dismissInstalledReleaseNotes()
              }}
            />
          )}

          <DesktopSidebarAccount
            user={user}
            onOpenSettings={onOpenSettings}
            onLogout={onLogout}
            containerRef={settingsMenuRef}
            trailingActions={
              <GlobalImNotificationBell
                devices={devices}
                imNotificationSettings={imNotificationSettings}
                menuOpen={imNotificationMenuOpen}
                menuContainerRef={settingsMenuRef}
                onMenuOpenChange={open => {
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
            }
          />

          {installedReleaseNotes && (
            <AppReleaseNotesDialog
              open={releaseNotesDialogOpen}
              releaseNotes={installedReleaseNotes}
              onClose={() => setReleaseNotesDialogOpen(false)}
            />
          )}

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
            onCloneGitRepository={onCloneGitRepository}
            onStartGitCloneProject={onStartGitCloneProject}
            onOpenStandaloneWorkspace={onOpenStandaloneWorkspace}
            onGetRemoteDeviceStartupCommand={onGetRemoteDeviceStartupCommand}
            onRefreshDevices={onRefreshDevices}
          />
          <ArchiveConversationsConfirmDialog
            open={priorityArchiveItems !== null}
            title={t('workbench.priority_filter_archive_title', {
              defaultValue: '归档 {{count}} 个优先级任务？',
              count: priorityArchiveItems?.length ?? 0,
            })}
            description={t(
              'workbench.priority_filter_archive_description',
              '只会归档“优先级”分组中的任务，不会归档最近任务'
            )}
            confirmLabel={t('workbench.archive_project_dialog_confirm', '全部归档')}
            cancelLabel={t('workbench.cancel', '取消')}
            submitting={isArchivingPriority}
            testId="runtime-priority-archive-dialog"
            onClose={closePriorityArchiveDialog}
            onConfirm={() => void runPriorityArchive(priorityArchiveItems ?? [])}
          />
          <ArchiveConversationsConfirmDialog
            open={priorityForceArchiveItems !== null}
            title={t('workbench.archive_runtime_task_dirty_worktree_title')}
            description={t('workbench.archive_runtime_tasks_dirty_worktree_force_desc')}
            confirmLabel={t('workbench.archive_runtime_task_force_confirm')}
            cancelLabel={t('workbench.cancel', '取消')}
            submitting={isArchivingPriority}
            testId="runtime-priority-force-archive-dialog"
            onClose={closePriorityForceArchiveDialog}
            onConfirm={() =>
              void runPriorityArchive(priorityForceArchiveItems ?? [], { force: true })
            }
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
          <LocalProjectEditDialog
            open={editingLocalProject !== null}
            projectWork={editingLocalProject}
            device={
              devices.find(
                device =>
                  device.device_id ===
                  (editingLocalProject?.project.stateDeviceId ||
                    editingLocalProject?.deviceWorkspaces[0]?.deviceId)
              ) ?? null
            }
            onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
            onListDeviceDirectories={onListDeviceDirectories}
            onCreateDeviceDirectory={onCreateDeviceDirectory}
            projectSpaceApis={experimentalFeaturesEnabled ? projectSpaceApis : undefined}
            models={models}
            pluginApi={localProjectPluginApi}
            onClose={() => setEditingLocalProject(null)}
            onSave={data =>
              onUpdateLocalRuntimeProject
                ? onUpdateLocalRuntimeProject(data)
                : Promise.reject(new Error('Local project editing is unavailable'))
            }
            onDelete={() => {
              if (!editingLocalProject) return
              const projectId = runtimeProjectUiId(editingLocalProject.project)
              setEditingLocalProject(null)
              void onRemoveProject(projectId)
            }}
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
