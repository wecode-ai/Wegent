import { type PersonalHomeIssueDetailContext } from './WeworkPersonalHome'

import { type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  type CollaborationPlatformLocation,
  type CollaborationProjectRendererWorkspaceContext,
  type CollaborationProject,
  type SharedWorkspaceApi,
  type WeworkWorkspaceRuntimePort,
} from '@wegent/collaboration'

import { type DesktopSidebarAccountSettingsOptions } from '@/components/layout/DesktopSidebarAccount'

import type {
  ArchiveRuntimeConversationsResult,
  WorkbenchContextValue,
} from '@/features/workbench/workbenchContextTypes'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type {
  ProjectSpaceDetailServices,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'

import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'

import { type LocatedProjectSpace } from './projectSpaceSelection'

export interface WeworkCollaborationPlatformProps {
  user: User
  devices?: DeviceInfo[]
  localProjects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  services: WorkbenchServices
  startupActive?: boolean
  workspaceActive?: boolean
  homeDraft: Pick<
    WorkbenchContextValue['projectChat'],
    'inputByScope' | 'setInputForScope' | 'getInputRevisionForScope' | 'personalHomeTaskDraftStore'
  >
  activeProjectRef?: RuntimeProjectSpaceRef | null
  defaultProjectRequested?: boolean
  focusedPersonalIssueId?: string | null
  focusedItemId?: string | null
  focusedCommentId?: string | null
  focusedCommentRequestKey?: string | null
  onFocusedItemHandled?: () => void
  onActiveProjectChange?: (project: LocatedProjectSpace | null) => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onArchiveRuntimeTasks?: (
    addresses: RuntimeTaskAddress[]
  ) => Promise<ArchiveRuntimeConversationsResult | void> | ArchiveRuntimeConversationsResult | void
  onCancelRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  sendRuntimePaneMessage?: WorkbenchContextValue['sendRuntimePaneMessage']
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onLogout?: () => void
  renderLocalProjectImporter?: (input: {
    mode: 'folder' | 'existing'
    projects: ProjectWithTasks[]
    onClose: () => void
    onCreated: (
      runtimeProjectKey: string,
      projectName: string,
      workspaceRoots: string[]
    ) => Promise<void>
  }) => ReactNode
}
export interface WeworkSharedProjectProps {
  personalIssue?: PersonalHomeIssueDetailContext
  api: SharedWorkspaceApi
  projectCatalogApi?: SharedWorkspaceApi['projects']
  detailServices?: ProjectSpaceDetailServices
  devices?: DeviceInfo[]
  focusedCommentId?: string | null
  focusedCommentRequestKey?: string | null
  focusedItemId?: string | null
  localProjects: ProjectWithTasks[]
  locale: 'zh-CN' | 'en'
  location: CollaborationPlatformLocation
  onFocusedItemHandled?: () => void
  onOpenSettings?: (options?: DesktopSidebarAccountSettingsOptions) => void
  onOpenStandInSettings?(roleId: string, deviceId: string): void
  standInDeviceId?: string
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onCancelRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  sendRuntimePaneMessage?: WorkbenchContextValue['sendRuntimePaneMessage']
  project: CollaborationProject
  conversationRequestKey?: string
  onOpenProjectConversation?(): void
  runtimeTaskLifecycle?: RuntimeTaskLifecycleStoreSnapshot
  runtimeWork?: RuntimeWorkListResponse | null
  runtimePort?: IssueRuntimeBindingPort
  services: WorkbenchServices
  setLocation: Dispatch<SetStateAction<CollaborationPlatformLocation>>
  userId: string | number
  workspace: CollaborationProjectRendererWorkspaceContext | null
}
export type IssueRuntimeBindingPort = Pick<WeworkWorkspaceRuntimePort, 'bindTask' | 'unbindTask'>
