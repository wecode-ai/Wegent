import type { PointerEvent, PointerEventHandler } from 'react'

import type { ProjectDevicePluginApi } from '@/api/projectDevicePlugins'

import {
  type StandaloneRemoteDialogIntent,
  type StandaloneWorkspaceDialogMode,
} from '@/components/projects/StandaloneProjectDialogs'

import type {
  CloneGitRepositoryInput,
  DeviceInfo,
  RuntimeTaskSummary,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeIMNotificationSettingsResponse,
  RuntimeProjectAppearanceRequest,
  RuntimeProjectAiSettings,
  RuntimeProjectSpaceRef,
  RuntimeProjectPinRequest,
  RuntimeProjectReorderRequest,
  RuntimeTaskPinRequest,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
  User as UserProfile,
} from '@/types/api'
import type { CloudWorkStatus, RuntimeWorkLoadState } from '@/types/workbench'

import type {
  ArchiveRuntimeConversationsResult,
  ArchiveRuntimeTaskOptions,
  ArchiveRuntimeTaskResult,
} from '@/features/workbench/workbenchContextTypes'

import { type DesktopSidebarAccountSettingsOptions } from './DesktopSidebarAccount'

import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'
import type { WorkbenchSplitGroupMembership } from './workbenchSplitGroups'

export interface DesktopSidebarProps {
  user: UserProfile | null
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  cloudWorkStatus?: CloudWorkStatus
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeWorkLoad?: RuntimeWorkLoadState
  onRetryRuntimeWork?: () => Promise<void>
  currentRuntimeTask?: RuntimeTaskAddress | null
  splitGroupMemberships?: Readonly<Record<string, WorkbenchSplitGroupMembership>>
  standaloneDeviceId?: string | null
  standaloneWorkspacePath?: string | null
  imNotificationSettings?: RuntimeIMNotificationSettingsResponse | null
  unreadRuntimeTaskKeys?: ReadonlySet<string>
  standInUnreadCount?: number
  preferredDeviceId?: string | null
  activeItem?: 'chat' | 'plugins' | 'sites' | 'cloud-work' | 'automation' | 'stand-in'
  taskView?: 'workbench' | 'default-work-items'
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
  onOpenStandIn?: () => void
  onStartStandaloneChat: () => void
  onOpenLocalHarnessSession?: (sessionId: string) => void
  onCloseLocalHarnessSession?: (sessionId: string) => void | Promise<void>
  onOpenSearch?: () => void
  onToggleMyWork?: () => void
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
  onUpdateProjectName: (projectId: number, name: string) => Promise<void>
  onUpdateLocalRuntimeProject?: (data: {
    deviceId: string
    projectKey: string
    name: string
    roots: string[]
    defaultProjectSpace?: RuntimeProjectSpaceRef | null
    aiSettings?: RuntimeProjectAiSettings | null
  }) => Promise<void>
  onRemoveProject: (projectId: number) => Promise<void>
  onReorderRuntimeProjects?: (data: RuntimeProjectReorderRequest) => Promise<void>
  onSetRuntimeProjectPinned?: (data: RuntimeProjectPinRequest) => Promise<void>
  onSetRuntimeProjectAppearance?: (data: RuntimeProjectAppearanceRequest) => Promise<void>
  onSetRuntimeTaskPinned?: (data: RuntimeTaskPinRequest) => Promise<void>
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onCloneGitRepository?: (deviceId: string, input: CloneGitRepositoryInput) => Promise<void>
  projectDevicePluginApi?: (deviceId: string) => ProjectDevicePluginApi
  projectSpaceApis?: ProjectSpaceApi[]
  models?: UnifiedModel[]
  onOpenSettings: (options?: OpenSettingsOptions) => void
  onLogout: () => void
}

export type OpenSettingsOptions = DesktopSidebarAccountSettingsOptions

export type ProjectCreateMenuPosition = {
  top: number
  left: number
}

export type RuntimeTaskPriorityReason = 'active' | 'unread' | 'waiting'

export interface RuntimePriorityTaskItem {
  workspace: RuntimeDeviceWorkspace
  task: RuntimeTaskSummary
  projectName: string | null
  projectStateDeviceId: string | null
  isStandaloneChat: boolean
  reason: RuntimeTaskPriorityReason | null
}

export interface ArchiveConversationsConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  submitting?: boolean
  testId: string
  onClose: () => void
  onConfirm: () => Promise<void> | void
}

export type SidebarDeviceStatus = DeviceInfo['status'] | 'unavailable'

export interface SidebarDeviceState {
  deviceId: string
  device?: DeviceInfo
  status: SidebarDeviceStatus
}
