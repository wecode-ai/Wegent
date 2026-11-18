import { type QuestionDiscussionTab } from '@/features/notifications/questionDiscussion'
import { type McpAppPanelTab } from '@/features/mcp-apps/workspacePanels'

import type { ReactNode, Ref } from 'react'
import { type FileChangesReviewViewOption } from '@/components/chat/FileChangesReviewPanel'

import type { LocalHarnessWorkbenchSession } from '@/components/layout/localHarnessWorkbench'

import type { HarnessAppVerificationReport } from '@/api/local/harnessApps'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'

import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenOptions,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import type { BrowserAnnotationCommand, BrowserAnnotationScope } from '@/types/browser-annotation'

import { type EmbeddedBrowserOpenRequest } from '@/lib/embedded-browser'

import type { DeviceInfo, ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import type { GitPatchAction } from '@/api/environment'
import type { DesktopReviewMode } from '../desktopWorkbenchPaneTypes'
import {
  type FileWorkspacePanelHandle,
  type FileWorkspacePanelSelection,
} from './FileWorkspacePanel'
import { type WorkspaceFileTabId, type WorkspaceFileTabs } from './workspaceFileTabs'
import { type WorkspaceAddMenuItem } from './WorkspaceAddMenu'

import type { BackgroundTerminal } from '../backgroundTerminals'

import {
  type WeworkWorkspaceScope,
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
} from './rightWorkspaceDshSidebar'

export type RightWorkspaceChatTab = `chat:${string}`
export type RightWorkspaceBrowserTab = `browser:${string}`
export type RightWorkspaceHarnessTab = `harness:${string}`
export type RightWorkspaceTerminalTab = `terminal:${string}`
export type RightWorkspaceBackgroundTerminalTab = `background-terminal:${string}`
export type RightWorkspacePanelTab =
  | McpAppPanelTab
  | QuestionDiscussionTab
  | 'review'
  | 'files'
  | 'plan'
  | 'subagents'
  | 'work-item'
  | RightWorkspaceChatTab
  | RightWorkspaceBrowserTab
  | RightWorkspaceHarnessTab
  | RightWorkspaceTerminalTab
  | RightWorkspaceBackgroundTerminalTab
  | RightWorkspaceExtensionTab
  | WorkspaceFileTabId
export type RightWorkspacePanelView = 'launcher' | RightWorkspacePanelTab

export interface RightWorkspaceBrowserState {
  label: string
  nativeLabel?: string | null
  browserSessionId: string
  url: string | null
  title: string | null
  faviconUrl: string | null
  isLoading: boolean
  agentActive?: boolean
  hasActiveDownload: boolean
  openRequest: EmbeddedBrowserOpenRequest | null
  developmentPreview?: {
    installationId: string
    displayName: string
    workspaceTabId?: string
    status: 'starting' | 'ready' | 'reloading' | 'error'
    error?: string
    verificationStatus: 'unverified' | 'running' | 'passed' | 'failed' | 'stale'
    verificationReport?: HarnessAppVerificationReport | null
    verificationError?: string
  }
}

export interface RightWorkspaceReviewState {
  loading: boolean
  diff: string
  error?: string
  reviewTitle?: string
  defaultFileTreeVisible?: boolean
  branchName?: string
  targetBranchName?: string
  focusFilePath?: string
  reviewMode?: DesktopReviewMode
}

export type RightWorkspacePanelHandle = FileWorkspacePanelHandle

export interface RightWorkspacePanelProps {
  ref?: Ref<RightWorkspacePanelHandle>
  showWorkbenchBackground?: boolean
  visible: boolean
  renderTabsInAppTitlebar?: boolean
  expanded?: boolean
  allowTemporaryChat?: boolean
  activeView: RightWorkspacePanelView
  openTabs: RightWorkspacePanelTab[]
  currentProject: ProjectWithTasks | null
  canBrowseFiles: boolean
  currentRuntimeTask: RuntimeTaskAddress | null
  devices: DeviceInfo[]
  workspaceTarget: WorkspaceTarget | null
  fileWorkspaceTarget?: WorkspaceTarget | null
  fileWorkspaceTargets?: WorkspaceTarget[]
  preferLocalTerminal?: boolean
  terminalContextTitle?: string | null
  workspaceActions?: WorkspaceAddMenuItem[]
  harnessSessions?: LocalHarnessWorkbenchSession[]
  workspaceSessionApi?: WorkspaceSessionApi
  workspaceFileApi: WorkspaceFileApi
  openFileRequest?: WorkspaceFileOpenRequest | null
  initialFileSelection?: FileWorkspacePanelSelection | null
  fileTabs?: WorkspaceFileTabs
  onOpenFileTab?: (target: WorkspaceTarget, path: string) => void
  workspaceTargetError?: string | null
  review: RightWorkspaceReviewState
  planContent?: string | null
  subagentPanel?: ReactNode
  backgroundTerminals?: BackgroundTerminal[]
  workItemPanel?: ReactNode
  extensionTabs?: Partial<Record<RightWorkspaceExtensionTab, RightWorkspaceExtensionTabState>>
  extensionScope: WeworkWorkspaceScope
  browserStates: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>
  browserTransferSourceLabels?: Partial<Record<RightWorkspaceBrowserTab, string>>
  onBrowserStateChange: (
    tab: RightWorkspaceBrowserTab,
    update: Partial<RightWorkspaceBrowserState>
  ) => void
  onReloadSmartAppDevelopmentPreview?: (
    tab: RightWorkspaceBrowserTab,
    installationId: string
  ) => void
  onAddSmartAppDevelopmentPlugin?: (
    tab: RightWorkspaceBrowserTab,
    installationId: string,
    pluginSpec: string
  ) => Promise<void>
  onVerifySmartAppDevelopmentPreview?: (
    tab: RightWorkspaceBrowserTab,
    installationId: string
  ) => void
  codeCommentCount?: number
  codeCommentContexts?: CodeCommentContext[]
  browserAnnotationCommand?: BrowserAnnotationCommand | null
  canOpenReview: boolean
  reviewViewOptions?: FileChangesReviewViewOption[]
  onAddCodeComment: (context: CodeCommentContext) => void
  onReplaceBrowserCodeComments?: (
    scope: BrowserAnnotationScope,
    contexts: CodeCommentContext[]
  ) => void
  onRemoveBrowserCodeComments?: (scope: BrowserAnnotationScope) => void
  onFileDirtyChange?: (dirty: boolean) => void
  onFileSelectionChange?: (selection: FileWorkspacePanelSelection) => void
  onSelectFileWorkspaceTarget?: (target: WorkspaceTarget) => void
  onSelectReview: () => void
  onSelectTerminal: () => void
  onSelectBrowser: () => void
  onSelectFiles: () => void
  onSelectChat: () => void
  onSelectPlan: () => void
  onSelectTab: (tab: RightWorkspacePanelTab) => void
  onCloseTab: (tab: RightWorkspacePanelTab) => void
  onHarnessSessionExit?: (sessionId: string) => void
  onRefreshReview?: () => void
  onOpenWorkspaceFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  onOpenReviewSourceFile?: (path: string, lineStart?: number, lineEnd?: number) => void
  onApplyReviewPatch?: (action: GitPatchAction, patch: string) => Promise<void>
  onRestoreConversation?: () => void
  getChatInitialInput?: (tab: RightWorkspaceChatTab) => string | undefined
  getChatInitialAddress?: (tab: RightWorkspaceChatTab) => RuntimeTaskAddress | null | undefined
  onChatAddressChange?: (tab: RightWorkspaceChatTab, address: RuntimeTaskAddress | null) => void
}

export interface RightWorkspaceBrowserPanelSlotProps {
  tab: RightWorkspaceBrowserTab
  active: boolean
  state: RightWorkspaceBrowserState
  transferFromLabel?: string
  codeCommentCount: number
  codeCommentContexts: CodeCommentContext[]
  browserAnnotationCommand?: BrowserAnnotationCommand | null
  onAddCodeComment: (context: CodeCommentContext) => void
  onReplaceBrowserCodeComments?: (
    scope: BrowserAnnotationScope,
    contexts: CodeCommentContext[]
  ) => void
  onRemoveBrowserCodeComments?: (scope: BrowserAnnotationScope) => void
  onBrowserStateChange: (
    tab: RightWorkspaceBrowserTab,
    update: Partial<RightWorkspaceBrowserState>
  ) => void
}
