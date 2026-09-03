import {
  File,
  FileDiff,
  Globe2,
  LayoutDashboard,
  ListChecks,
  Loader2,
  MessageCircle,
  PanelRight,
  Plus,
  Puzzle,
  RefreshCw,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import {
  FileChangesReviewPanel,
  type FileChangesReviewViewOption,
} from '@/components/chat/FileChangesReviewPanel'
import { AssistantMarkdown } from '@/components/chat/AssistantMarkdown'
import { CentralHarnessTerminal } from '@/components/layout/CentralHarnessTerminal'
import type { LocalHarnessWorkbenchSession } from '@/components/layout/localHarnessWorkbench'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { TitlebarRightPanelPortal } from '@/components/topnav/TitlebarActionsPortal'
import { SmartAppPluginDialog } from '@/features/harness-apps/SmartAppPluginDialog'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  CodeCommentContext,
  WorkspaceFileApi,
  WorkspaceFileOpenRequest,
  WorkspaceTarget,
} from '@/types/workspace-files'
import type { BrowserAnnotationCommand, BrowserAnnotationScope } from '@/types/browser-annotation'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import { reloadEmbeddedBrowser, type EmbeddedBrowserOpenRequest } from '@/lib/embedded-browser'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { isEditableShortcutTarget } from '@/lib/keybindings'
import { FileWorkspacePanel, type FileWorkspacePanelSelection } from './FileWorkspacePanel'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspaceBrowserPanel } from './WorkspaceBrowserPanelContainer'
import { WorkspacePanelCards } from './WorkspacePanelCards'
import { TemporaryChatPanel } from './TemporaryChatPanel'
import { DshSidebarExtensionPanel } from './DshSidebarExtensionPanel'
import { BrowserAgentCursorIcon } from './BrowserAgentCursorIcon'
import {
  resolveRightWorkspaceExtensionDescriptor,
  rightWorkspaceDshSidebar,
  isRightWorkspaceExtensionTab,
  titleOfWeworkWorkspaceSidebarTab,
  type WeworkWorkspaceScope,
  type WeworkWorkspaceSidebarTabDescriptor,
  type RightWorkspaceExtensionTab,
  type RightWorkspaceExtensionTabState,
} from './rightWorkspaceDshSidebar'

function getRightWorkspaceShortcuts(platform: ReturnType<typeof getPlatform>) {
  if (platform === 'win') {
    return {
      review: 'Alt+Ctrl+R',
      browser: 'Ctrl+T',
      chat: 'Alt+Ctrl+S',
      files: 'Alt+Ctrl+F',
    } as const
  }
  return {
    review: '⌥⌘R',
    browser: '⌘T',
    chat: '⌥⌘S',
    files: '⌥⌘F',
  } as const
}

export type RightWorkspaceChatTab = `chat:${string}`
export type RightWorkspaceBrowserTab = `browser:${string}`
export type RightWorkspaceHarnessTab = `harness:${string}`
export type RightWorkspaceTerminalTab = `terminal:${string}`
export type RightWorkspacePanelTab =
  | 'review'
  | 'files'
  | 'plan'
  | 'work-item'
  | RightWorkspaceChatTab
  | RightWorkspaceBrowserTab
  | RightWorkspaceHarnessTab
  | RightWorkspaceTerminalTab
  | RightWorkspaceExtensionTab
export type RightWorkspacePanelView = 'launcher' | RightWorkspacePanelTab

function isRightWorkspaceChatTab(tab: RightWorkspacePanelView): tab is RightWorkspaceChatTab {
  return tab.startsWith('chat:')
}

function isRightWorkspaceBrowserTab(tab: RightWorkspacePanelView): tab is RightWorkspaceBrowserTab {
  return tab.startsWith('browser:')
}

function isRightWorkspaceHarnessTab(tab: RightWorkspacePanelView): tab is RightWorkspaceHarnessTab {
  return tab.startsWith('harness:')
}

function isRightWorkspaceTerminalTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceTerminalTab {
  return tab.startsWith('terminal:')
}

function getRightWorkspaceHarnessSessionId(tab: RightWorkspaceHarnessTab) {
  return tab.slice('harness:'.length)
}

function getRightWorkspaceChatTabSuffix(tab: RightWorkspaceChatTab) {
  return tab.slice('chat:'.length)
}

function getRightWorkspaceBrowserTabSuffix(tab: RightWorkspaceBrowserTab) {
  return tab.slice('browser:'.length)
}

function getRightWorkspaceTerminalTabSuffix(tab: RightWorkspaceTerminalTab) {
  return tab.slice('terminal:'.length)
}

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
  }
}

interface RightWorkspaceReviewState {
  loading: boolean
  diff: string
  error?: string
  reviewTitle?: string
  defaultFileTreeVisible?: boolean
  branchName?: string
  targetBranchName?: string
  focusFilePath?: string
}

interface RightWorkspacePanelProps {
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
  workspaceTargetError?: string | null
  review: RightWorkspaceReviewState
  planContent?: string | null
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
  onRestoreConversation?: () => void
  getChatInitialInput?: (tab: RightWorkspaceChatTab) => string | undefined
  getChatInitialAddress?: (tab: RightWorkspaceChatTab) => RuntimeTaskAddress | null | undefined
  onChatAddressChange?: (tab: RightWorkspaceChatTab, address: RuntimeTaskAddress | null) => void
}

interface RightWorkspaceBrowserPanelSlotProps {
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

function RightWorkspaceBrowserPanelSlot({
  tab,
  active,
  state,
  transferFromLabel,
  codeCommentCount,
  codeCommentContexts,
  browserAnnotationCommand,
  onAddCodeComment,
  onReplaceBrowserCodeComments,
  onRemoveBrowserCodeComments,
  onBrowserStateChange,
}: RightWorkspaceBrowserPanelSlotProps) {
  const handleDownloadActivityChange = useCallback(
    (hasActiveDownload: boolean) => onBrowserStateChange(tab, { hasActiveDownload }),
    [onBrowserStateChange, tab]
  )
  const handleFaviconChange = useCallback(
    (faviconUrl: string | null) => onBrowserStateChange(tab, { faviconUrl }),
    [onBrowserStateChange, tab]
  )
  const handleLoadingChange = useCallback(
    (isLoading: boolean) => onBrowserStateChange(tab, { isLoading }),
    [onBrowserStateChange, tab]
  )
  const handleAgentActiveChange = useCallback(
    (agentActive: boolean) => onBrowserStateChange(tab, { agentActive }),
    [onBrowserStateChange, tab]
  )
  const handleTitleChange = useCallback(
    (title: string | null) => onBrowserStateChange(tab, { title }),
    [onBrowserStateChange, tab]
  )
  const handleNativeLabelChange = useCallback(
    (nativeLabel: string | null) => onBrowserStateChange(tab, { nativeLabel }),
    [onBrowserStateChange, tab]
  )
  const handleUrlChange = useCallback(
    (url: string | null) => onBrowserStateChange(tab, { url }),
    [onBrowserStateChange, tab]
  )

  return (
    <WorkspaceBrowserPanel
      active={active}
      hideToolbar={Boolean(state.developmentPreview)}
      label={state.label}
      transferFromLabel={transferFromLabel}
      transferredNativeLabel={transferFromLabel ? state.nativeLabel : null}
      transferredUrl={transferFromLabel ? state.url : null}
      browserTabId={tab}
      openRequest={state.openRequest}
      codeCommentCount={codeCommentCount}
      codeCommentContexts={codeCommentContexts}
      browserAnnotationCommand={browserAnnotationCommand}
      onAddCodeComment={onAddCodeComment}
      onReplaceBrowserCodeComments={onReplaceBrowserCodeComments}
      onRemoveBrowserCodeComments={onRemoveBrowserCodeComments}
      onDownloadActivityChange={handleDownloadActivityChange}
      onFaviconChange={handleFaviconChange}
      onLoadingChange={handleLoadingChange}
      onAgentActiveChange={handleAgentActiveChange}
      onTitleChange={handleTitleChange}
      onNativeLabelChange={handleNativeLabelChange}
      onUrlChange={handleUrlChange}
    />
  )
}

function SmartAppDevelopmentPreviewState({
  status,
  error,
}: {
  status: 'starting' | 'reloading' | 'error'
  error?: string | null
}) {
  const { t } = useTranslation('common')
  const isError = status === 'error'
  const message =
    status === 'starting'
      ? t('workbench.smart_app_preview_starting')
      : status === 'reloading'
        ? t('workbench.smart_app_preview_reloading')
        : error || t('workbench.smart_app_preview_failed')

  return (
    <div
      data-testid={`smart-app-development-preview-${status}`}
      className="flex min-h-0 flex-1 items-center justify-center bg-background px-6 text-center"
    >
      <div className="flex max-w-sm flex-col items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          {isError ? (
            <LayoutDashboard className="h-5 w-5" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin" />
          )}
        </div>
        <div className="text-sm font-medium text-text-primary">{message}</div>
        {!isError ? (
          <div className="text-xs text-text-secondary">
            {t('workbench.smart_app_preview_starting_hint')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export const RightWorkspacePanel = memo(function RightWorkspacePanel({
  showWorkbenchBackground = false,
  visible,
  renderTabsInAppTitlebar = true,
  expanded = false,
  allowTemporaryChat = true,
  activeView,
  openTabs,
  currentProject,
  canBrowseFiles,
  currentRuntimeTask,
  devices,
  workspaceTarget,
  fileWorkspaceTarget = workspaceTarget,
  fileWorkspaceTargets,
  preferLocalTerminal = false,
  terminalContextTitle,
  workspaceActions = [],
  harnessSessions = [],
  workspaceSessionApi,
  workspaceFileApi,
  openFileRequest,
  initialFileSelection,
  workspaceTargetError,
  review,
  planContent,
  workItemPanel,
  extensionTabs = {},
  extensionScope,
  browserStates,
  browserTransferSourceLabels = {},
  onBrowserStateChange,
  onReloadSmartAppDevelopmentPreview,
  onAddSmartAppDevelopmentPlugin,
  codeCommentCount = 0,
  codeCommentContexts = [],
  browserAnnotationCommand,
  canOpenReview,
  reviewViewOptions,
  onAddCodeComment,
  onReplaceBrowserCodeComments,
  onRemoveBrowserCodeComments,
  onFileDirtyChange,
  onFileSelectionChange,
  onSelectFileWorkspaceTarget,
  onSelectReview,
  onSelectTerminal,
  onSelectBrowser,
  onSelectFiles,
  onSelectChat,
  onSelectTab,
  onCloseTab,
  onHarnessSessionExit,
  onRefreshReview,
  onRestoreConversation,
  getChatInitialInput,
  getChatInitialAddress,
  onChatAddressChange,
}: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const registeredExtensionTabs = useSyncExternalStore(
    rightWorkspaceDshSidebar.subscribe,
    rightWorkspaceDshSidebar.getTabs,
    rightWorkspaceDshSidebar.getTabs
  )
  const [pluginDialog, setPluginDialog] = useState<{
    tab: RightWorkspaceBrowserTab
    installationId: string
    displayName: string
  } | null>(null)
  const availableTabs = allowTemporaryChat
    ? openTabs
    : openTabs.filter(tab => !isRightWorkspaceChatTab(tab))
  const visibleTabs = canBrowseFiles ? availableTabs : availableTabs.filter(tab => tab !== 'files')
  const showTabs = visibleTabs.length > 0
  const platform = getPlatform()
  const renderTabsInTitlebar =
    renderTabsInAppTitlebar && isDesktopRuntime() && platform !== 'win' && visible && showTabs
  const harnessSessionsById = new Map(
    harnessSessions.map(session => [session.sessionId, session] as const)
  )

  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isEditableShortcutTarget(event.target)) return

      const key = event.key.toLowerCase()
      const primaryPressed =
        platform === 'win'
          ? event.ctrlKey && !event.metaKey && !event.shiftKey
          : event.metaKey && !event.shiftKey

      if (primaryPressed && !event.altKey && key === 't') {
        event.preventDefault()
        onSelectBrowser()
        return
      }

      if (!primaryPressed || !event.altKey) return

      if (key === 'r' && canOpenReview) {
        event.preventDefault()
        onSelectReview()
      } else if (key === 's' && allowTemporaryChat) {
        event.preventDefault()
        onSelectChat()
      } else if (key === 'f' && canBrowseFiles) {
        event.preventDefault()
        onSelectFiles()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    allowTemporaryChat,
    canBrowseFiles,
    canOpenReview,
    onSelectBrowser,
    onSelectChat,
    onSelectFiles,
    onSelectReview,
    platform,
    visible,
  ])

  const closeTab = (tab: RightWorkspacePanelTab) => onCloseTab(tab)

  const getTabSelectHandler =
    (tab: RightWorkspacePanelTab): (() => void) =>
    () =>
      onSelectTab(tab)

  const getNewTabOptions = (): WorkspaceAddMenuItem[] => [
    ...workspaceActions,
    ...[...registeredExtensionTabs]
      .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
      .map(
        (descriptor): WorkspaceAddMenuItem => ({
          id: `wework-sidebar-extension:${descriptor.id}`,
          testId: `right-workspace-extension-option-${descriptor.id}`,
          icon: PanelRight,
          label: titleOfWeworkWorkspaceSidebarTab(descriptor),
          onSelect: () => rightWorkspaceDshSidebar.openTab({ type: descriptor.id }),
        })
      ),
    {
      id: 'review',
      testId: 'right-workspace-review-option',
      icon: FileDiff,
      label: t('workbench.workspace_tab_review', '审查'),
      shortcut: getRightWorkspaceShortcuts(platform).review,
      disabled: !canOpenReview,
      onSelect: onSelectReview,
    },
    {
      id: 'terminal',
      testId: 'right-workspace-terminal-option',
      icon: SquareTerminal,
      label: t('workbench.terminal', '终端'),
      onSelect: onSelectTerminal,
    },
    {
      id: 'browser' as const,
      testId: 'right-workspace-browser-option',
      icon: Globe2,
      label: t('workbench.browser'),
      shortcut: getRightWorkspaceShortcuts(platform).browser,
      onSelect: onSelectBrowser,
    },
    ...(allowTemporaryChat
      ? [
          {
            id: 'chat' as const,
            testId: 'right-workspace-chat-option',
            icon: MessageCircle,
            label: t('workbench.workspace_tab_chat', '临时聊天'),
            shortcut: getRightWorkspaceShortcuts(platform).chat,
            onSelect: onSelectChat,
          },
        ]
      : []),
    ...(canBrowseFiles
      ? [
          {
            id: 'files' as const,
            testId: 'right-workspace-file-option',
            icon: File,
            label: t('workbench.workspace_tab_files', '文件'),
            shortcut: getRightWorkspaceShortcuts(platform).files,
            onSelect: onSelectFiles,
          },
        ]
      : []),
  ]

  const tabBar = showTabs ? (
    <header
      data-testid="right-workspace-tabbar"
      role="tablist"
      className={cn(
        'electron-titlebar-interactive-region relative z-chrome flex shrink-0 items-center gap-1.5 pointer-events-auto',
        renderTabsInTitlebar
          ? 'h-[38px] w-full bg-transparent pl-4 pr-2'
          : cn(
              'h-10 px-3',
              platform === 'win' ? '' : 'border-b border-border',
              showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
            )
      )}
    >
      {visibleTabs.map(tab => (
        <RightWorkspaceTitleTab
          key={tab}
          tab={tab}
          active={activeView === tab}
          label={getRightWorkspaceTabLabel(
            tab,
            t,
            browserStates,
            harnessSessionsById,
            extensionTabs
          )}
          icon={
            isRightWorkspaceBrowserTab(tab) && browserStates[tab]?.developmentPreview
              ? LayoutDashboard
              : getRightWorkspaceTabIcon(tab)
          }
          extensionState={isRightWorkspaceExtensionTab(tab) ? extensionTabs[tab] : undefined}
          iconSrc={
            isRightWorkspaceBrowserTab(tab) && !browserStates[tab]?.developmentPreview
              ? browserStates[tab]?.faviconUrl
              : null
          }
          loading={
            isRightWorkspaceBrowserTab(tab) &&
            (browserStates[tab]?.isLoading ||
              browserStates[tab]?.developmentPreview?.status === 'starting' ||
              browserStates[tab]?.developmentPreview?.status === 'reloading')
          }
          agentActive={isRightWorkspaceBrowserTab(tab) && browserStates[tab]?.agentActive}
          onSelect={getTabSelectHandler(tab)}
          onClose={() => closeTab(tab)}
        />
      ))}
      <div className="relative">
        {visible ? (
          <WorkspaceAddMenu
            ariaLabel={t('workbench.workspace_tab_new', '打开新标签页')}
            buttonTestId="right-workspace-new-tab-button"
            menuTestId="right-workspace-new-tab-menu"
            items={getNewTabOptions()}
            buttonClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary pointer-events-auto"
          />
        ) : (
          <button
            type="button"
            data-testid="right-workspace-new-tab-button"
            disabled
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary opacity-50"
            aria-label={t('workbench.workspace_tab_new', '打开新标签页')}
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>
      {renderTabsInTitlebar ? (
        <div
          data-testid="right-workspace-titlebar-drag-region"
          className="min-w-0 flex-1 self-stretch"
        >
          <MacOSTitleBarDragRegion className="h-full w-full" />
        </div>
      ) : null}
    </header>
  ) : null
  const chatTabs = allowTemporaryChat ? openTabs.filter(isRightWorkspaceChatTab) : []

  return (
    <section
      data-testid="right-workspace-panel"
      className={cn(
        'relative flex h-full w-full min-w-0 flex-1 basis-0 flex-col opacity-100 transition-[opacity,transform] duration-300 ease-out',
        showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
      )}
    >
      {renderTabsInTitlebar ? <TitlebarRightPanelPortal>{tabBar}</TitlebarRightPanelPortal> : null}
      {renderTabsInTitlebar ? null : tabBar}
      <div className="flex min-h-0 flex-1">
        {!isRightWorkspaceChatTab(activeView) && activeView === 'launcher' ? (
          <RightWorkspaceLauncher
            canOpenReview={canOpenReview}
            canBrowseFiles={canBrowseFiles}
            allowTemporaryChat={allowTemporaryChat}
            workspaceActions={workspaceActions}
            extensionTabs={registeredExtensionTabs}
            onSelectReview={onSelectReview}
            onSelectTerminal={onSelectTerminal}
            onSelectBrowser={onSelectBrowser}
            onSelectFiles={onSelectFiles}
            onSelectChat={onSelectChat}
          />
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'review' ? (
          <FileChangesReviewPanel
            loading={review.loading}
            diff={review.diff}
            error={review.error}
            reviewTitle={review.reviewTitle}
            defaultFileTreeVisible={review.defaultFileTreeVisible}
            branchName={review.branchName}
            targetBranchName={review.targetBranchName}
            focusFilePath={review.focusFilePath}
            viewOptions={reviewViewOptions}
            onRefresh={onRefreshReview}
          />
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'plan' ? (
          <PlanWorkspacePanel content={planContent ?? ''} />
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'work-item' ? (
          workItemPanel
        ) : activeView === 'files' && workspaceTargetError ? (
          <section
            data-testid="workspace-target-error"
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-red-500"
          >
            {workspaceTargetError}
          </section>
        ) : (
          !isRightWorkspaceChatTab(activeView) &&
          canBrowseFiles &&
          activeView === 'files' && (
            <FileWorkspacePanel
              key={
                fileWorkspaceTarget
                  ? `${fileWorkspaceTarget.deviceId}:${fileWorkspaceTarget.path}`
                  : 'empty'
              }
              target={fileWorkspaceTarget}
              workspaceTargets={fileWorkspaceTargets}
              workspaceFileApi={workspaceFileApi}
              openFileRequest={openFileRequest}
              initialSelection={initialFileSelection}
              onAddCodeComment={onAddCodeComment}
              onDirtyChange={onFileDirtyChange}
              onSelectionChange={onFileSelectionChange}
              onSelectWorkspaceTarget={onSelectFileWorkspaceTarget}
            />
          )
        )}
        {chatTabs.map(tab => (
          <div
            key={tab}
            className={cn(
              'min-h-0 min-w-0 flex-1 flex-col',
              activeView === tab ? 'flex' : 'hidden'
            )}
          >
            <TemporaryChatPanel
              currentProject={currentProject}
              source={currentRuntimeTask}
              instanceId={tab}
              initialInput={getChatInitialInput?.(tab)}
              initialAddress={getChatInitialAddress?.(tab)}
              onAddressChange={address => onChatAddressChange?.(tab, address)}
              expanded={expanded && activeView === tab}
              onRestoreConversation={onRestoreConversation}
              testId={
                activeView === tab
                  ? 'right-workspace-chat-panel'
                  : `right-workspace-chat-panel-${getRightWorkspaceChatTabSuffix(tab)}`
              }
            />
          </div>
        ))}
        {openTabs.filter(isRightWorkspaceTerminalTab).map(tab => (
          <div
            key={tab}
            className={cn('min-h-0 flex-1 flex-col', activeView === tab ? 'flex' : 'hidden')}
          >
            <WorkspacePanelCards
              showWorkbenchBackground={showWorkbenchBackground}
              currentProject={currentProject}
              devices={devices}
              workspaceTarget={workspaceTarget}
              defaultOpenTool="terminal"
              hideTerminalChrome
              preferLocalTerminal={preferLocalTerminal}
              terminalContextTitle={terminalContextTitle}
              workspaceSessionApi={workspaceSessionApi}
              panelActive={visible && activeView === tab}
            />
          </div>
        ))}
        {openTabs.filter(isRightWorkspaceBrowserTab).map(tab => {
          const browserState = browserStates[tab]
          if (!browserState) return null
          const developmentPreview = browserState.developmentPreview
          const browserPanel = (
            <RightWorkspaceBrowserPanelSlot
              tab={tab}
              active={visible && activeView === tab}
              state={browserState}
              transferFromLabel={browserTransferSourceLabels[tab]}
              codeCommentCount={codeCommentCount}
              codeCommentContexts={codeCommentContexts}
              browserAnnotationCommand={browserAnnotationCommand}
              onAddCodeComment={onAddCodeComment}
              onReplaceBrowserCodeComments={onReplaceBrowserCodeComments}
              onRemoveBrowserCodeComments={onRemoveBrowserCodeComments}
              onBrowserStateChange={onBrowserStateChange}
            />
          )
          return (
            <div
              key={tab}
              className={cn('min-h-0 flex-1 flex-col', activeView === tab ? 'flex' : 'hidden')}
            >
              {developmentPreview ? (
                <section
                  data-testid="smart-app-development-preview"
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-muted/30 px-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <LayoutDashboard className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 truncate text-sm font-medium text-text-primary">
                        {developmentPreview.displayName}
                        <span className="ml-2 text-xs font-normal text-text-secondary">
                          {developmentPreview.status === 'starting'
                            ? t('workbench.smart_app_preview_starting')
                            : developmentPreview.status === 'reloading'
                              ? t('workbench.smart_app_preview_reloading')
                              : developmentPreview.status === 'error'
                                ? developmentPreview.error
                                : t('workbench.smart_app_preview_ready')}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center justify-end gap-1">
                      <button
                        type="button"
                        data-testid="smart-app-development-preview-add-plugins"
                        disabled={developmentPreview.status !== 'ready'}
                        onClick={() =>
                          setPluginDialog({
                            tab,
                            installationId: developmentPreview.installationId,
                            displayName: developmentPreview.displayName,
                          })
                        }
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Puzzle className="h-3.5 w-3.5" />
                        {t('workbench.smart_app_preview_add_plugins')}
                      </button>
                      <button
                        type="button"
                        data-testid="smart-app-development-preview-refresh"
                        disabled={developmentPreview.status !== 'ready'}
                        onClick={() => void reloadEmbeddedBrowser(browserState.label)}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {t('workbench.smart_app_preview_refresh')}
                      </button>
                      <button
                        type="button"
                        data-testid="smart-app-development-preview-reload"
                        disabled={
                          developmentPreview.status === 'starting' ||
                          developmentPreview.status === 'reloading'
                        }
                        onClick={() =>
                          onReloadSmartAppDevelopmentPreview?.(
                            tab,
                            developmentPreview.installationId
                          )
                        }
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RefreshCw
                          className={cn(
                            'h-3.5 w-3.5',
                            (developmentPreview.status === 'starting' ||
                              developmentPreview.status === 'reloading') &&
                              'animate-spin'
                          )}
                        />
                        {t('workbench.smart_app_preview_reload')}
                      </button>
                    </div>
                  </header>
                  {developmentPreview.status === 'ready' ? (
                    browserPanel
                  ) : (
                    <SmartAppDevelopmentPreviewState
                      status={developmentPreview.status}
                      error={developmentPreview.error}
                    />
                  )}
                </section>
              ) : (
                browserPanel
              )}
            </div>
          )
        })}
        {openTabs.filter(isRightWorkspaceHarnessTab).map(tab => {
          const session = harnessSessionsById.get(getRightWorkspaceHarnessSessionId(tab))
          if (!session) return null
          return (
            <div
              key={tab}
              className={cn('min-h-0 flex-1 flex-col', activeView === tab ? 'flex' : 'hidden')}
            >
              <CentralHarnessTerminal
                sessionId={session.sessionId}
                title={session.title}
                cwd={session.cwd}
                active={visible && activeView === tab && session.active}
                showHeader={false}
                onExit={() => onHarnessSessionExit?.(session.sessionId)}
              />
            </div>
          )
        })}
        {openTabs.filter(isRightWorkspaceExtensionTab).map(tab => {
          const extensionState = extensionTabs[tab]
          const descriptor = resolveRightWorkspaceExtensionDescriptor(extensionState)
          if (!extensionState || !descriptor) return null
          return (
            <div
              key={tab}
              data-testid={`right-workspace-extension-panel-${descriptor.id}`}
              className={cn('min-h-0 flex-1 flex-col', activeView === tab ? 'flex' : 'hidden')}
            >
              <DshSidebarExtensionPanel
                descriptor={descriptor}
                scope={extensionScope}
                tab={extensionState.tab}
                visible={visible && activeView === tab}
              />
            </div>
          )
        })}
      </div>
      {pluginDialog ? (
        <SmartAppPluginDialog
          displayName={pluginDialog.displayName}
          onClose={() => setPluginDialog(null)}
          onInstall={pluginSpec =>
            onAddSmartAppDevelopmentPlugin
              ? onAddSmartAppDevelopmentPlugin(
                  pluginDialog.tab,
                  pluginDialog.installationId,
                  pluginSpec
                )
              : Promise.reject(new Error('Smart app plugin installation is unavailable'))
          }
        />
      ) : null}
    </section>
  )
})

function RightWorkspaceTitleTab({
  tab,
  active,
  label,
  icon: Icon,
  extensionState,
  iconSrc,
  loading = false,
  agentActive = false,
  onSelect,
  onClose,
}: {
  tab: RightWorkspacePanelTab
  active: boolean
  label: string
  icon: LucideIcon
  extensionState?: RightWorkspaceExtensionTabState
  iconSrc?: string | null
  loading?: boolean
  agentActive?: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onSelect()
  }

  return (
    <div
      data-testid={getRightWorkspaceTabTestId(tab)}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        'group/tab relative flex h-8 min-w-0 max-w-[200px] cursor-pointer items-stretch rounded-md text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 pointer-events-auto',
        active
          ? 'bg-muted text-text-primary'
          : 'text-text-secondary hover:bg-muted hover:text-text-primary'
      )}
    >
      <button
        type="button"
        onClick={event => {
          event.stopPropagation()
          onSelect()
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 pl-2 pr-7 text-left"
      >
        <RightWorkspaceTabIcon
          icon={Icon}
          extensionState={extensionState}
          iconSrc={iconSrc}
          loading={loading}
          agentActive={agentActive}
          testId={getRightWorkspaceTabTestId(tab)}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      <span className="pointer-events-none absolute right-1 top-1/2 z-critical flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 hover:pointer-events-auto hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <button
          type="button"
          data-testid={`${getRightWorkspaceTabTestId(tab)}-close-button`}
          onClick={event => {
            event.stopPropagation()
            onClose()
          }}
          className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label={t('workbench.close_right_workspace_panel')}
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    </div>
  )
}

function RightWorkspaceTabIcon({
  icon: Icon,
  extensionState,
  iconSrc,
  loading,
  agentActive,
  testId,
}: {
  icon: ComponentType<{ className?: string }>
  extensionState?: RightWorkspaceExtensionTabState
  iconSrc?: string | null
  loading: boolean
  agentActive: boolean
  testId: string
}) {
  const [failedIconSrc, setFailedIconSrc] = useState<string | null>(null)
  const imageFailed = Boolean(iconSrc && failedIconSrc === iconSrc)

  if (agentActive) {
    return <BrowserAgentCursorIcon testId={`${testId}-agent-icon`} className="h-4 w-4" />
  }

  if (loading) {
    return (
      <Loader2
        data-testid={`${testId}-loading-icon`}
        className="h-3.5 w-3.5 shrink-0 animate-spin text-text-secondary"
      />
    )
  }

  const descriptor = resolveRightWorkspaceExtensionDescriptor(extensionState)
  if (descriptor) return <PanelRight data-testid={`${testId}-icon`} className="h-4 w-4 shrink-0" />

  if (iconSrc && !imageFailed) {
    return (
      <img
        data-testid={`${testId}-favicon`}
        src={iconSrc}
        alt=""
        className="h-4 w-4 shrink-0 rounded-[3px] object-contain"
        onError={() => setFailedIconSrc(iconSrc)}
      />
    )
  }

  return (
    <Icon data-testid={`${testId}-icon`} className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
  )
}

function PlanWorkspacePanel({ content }: { content: string }) {
  const { t } = useTranslation('common')

  return (
    <section
      data-testid="workspace-plan-panel"
      className="min-h-0 flex-1 overflow-y-auto bg-background px-8 py-6"
    >
      <div className="mx-auto max-w-4xl text-base leading-7 text-text-primary">
        {content.trim() ? (
          <AssistantMarkdown content={content} />
        ) : (
          <div className="text-sm text-text-muted">
            {t('workbench.workspace_plan_empty', '暂无计划内容')}
          </div>
        )}
      </div>
    </section>
  )
}

function RightWorkspaceLauncher({
  canOpenReview,
  canBrowseFiles,
  allowTemporaryChat,
  workspaceActions,
  extensionTabs,
  onSelectReview,
  onSelectTerminal,
  onSelectBrowser,
  onSelectFiles,
  onSelectChat,
}: {
  canOpenReview: boolean
  canBrowseFiles: boolean
  allowTemporaryChat: boolean
  workspaceActions: WorkspaceAddMenuItem[]
  extensionTabs: readonly WeworkWorkspaceSidebarTabDescriptor[]
  onSelectReview: () => void
  onSelectTerminal: () => void
  onSelectBrowser: () => void
  onSelectFiles: () => void
  onSelectChat: () => void
}) {
  const { t } = useTranslation('common')
  const platform = getPlatform()

  return (
    <div
      data-testid="right-workspace-launcher"
      className="flex min-h-0 flex-1 items-center justify-center px-8"
    >
      <div className="flex w-full max-w-xl flex-col gap-1.5">
        {[...extensionTabs]
          .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
          .map(descriptor => (
            <RightWorkspaceLauncherItem
              key={descriptor.id}
              data-testid={`right-workspace-extension-option-${descriptor.id}`}
              icon={PanelRight}
              label={titleOfWeworkWorkspaceSidebarTab(descriptor)}
              onClick={() => rightWorkspaceDshSidebar.openTab({ type: descriptor.id })}
            />
          ))}
        {workspaceActions.map(action => (
          <RightWorkspaceLauncherItem
            key={action.id}
            data-testid={action.testId ?? `right-workspace-${action.id}-option`}
            icon={action.icon}
            label={action.label}
            shortcut={action.shortcut}
            onClick={() => void action.onSelect()}
            disabled={action.disabled}
          />
        ))}
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-review-option"
          icon={FileDiff}
          label={t('workbench.workspace_tab_review', '审查')}
          shortcut={getRightWorkspaceShortcuts(platform).review}
          onClick={onSelectReview}
          disabled={!canOpenReview}
        />
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-terminal-option"
          icon={SquareTerminal}
          label={t('workbench.terminal', '终端')}
          onClick={onSelectTerminal}
        />
        <RightWorkspaceLauncherItem
          data-testid="right-workspace-browser-option"
          icon={Globe2}
          label={t('workbench.browser')}
          shortcut={getRightWorkspaceShortcuts(platform).browser}
          onClick={onSelectBrowser}
        />
        {allowTemporaryChat && (
          <RightWorkspaceLauncherItem
            data-testid="right-workspace-chat-option"
            icon={MessageCircle}
            label={t('workbench.workspace_tab_chat', '临时聊天')}
            shortcut={getRightWorkspaceShortcuts(platform).chat}
            onClick={onSelectChat}
          />
        )}
        {canBrowseFiles && (
          <RightWorkspaceLauncherItem
            data-testid="right-workspace-file-option"
            icon={File}
            label={t('workbench.workspace_tab_files', '文件')}
            shortcut={getRightWorkspaceShortcuts(platform).files}
            onClick={onSelectFiles}
          />
        )}
      </div>
    </div>
  )
}

function RightWorkspaceLauncherItem({
  icon: Icon,
  label,
  shortcut,
  disabled,
  onClick,
  'data-testid': testId,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  shortcut?: string
  disabled?: boolean
  onClick: () => void
  'data-testid': string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 w-full items-center gap-2 rounded-xl bg-surface px-3 text-left text-sm font-light leading-[18px] text-text-primary transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-4 w-4 shrink-0 text-text-secondary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <span className="shrink-0 rounded-lg bg-background/80 px-1.5 py-0.5 text-xs font-light leading-4 text-text-muted shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]">
          {shortcut}
        </span>
      )}
    </button>
  )
}

function getRightWorkspaceTabLabel(
  tab: RightWorkspacePanelTab,
  t: ReturnType<typeof useTranslation>['t'],
  browserStates: Partial<Record<RightWorkspaceBrowserTab, RightWorkspaceBrowserState>>,
  harnessSessionsById: Map<string, LocalHarnessWorkbenchSession>,
  extensionTabs: Partial<Record<RightWorkspaceExtensionTab, RightWorkspaceExtensionTabState>>
) {
  if (isRightWorkspaceExtensionTab(tab)) {
    const descriptor = resolveRightWorkspaceExtensionDescriptor(extensionTabs[tab])
    if (!descriptor) return t('workbench.workspace_tab_plugin', '插件')
    return titleOfWeworkWorkspaceSidebarTab(descriptor)
  }
  if (tab === 'review') return t('workbench.workspace_tab_review', '审查')
  if (isRightWorkspaceTerminalTab(tab)) {
    const suffix = getRightWorkspaceTerminalTabSuffix(tab)
    return suffix === '1'
      ? t('workbench.terminal', '终端')
      : `${t('workbench.terminal', '终端')} ${suffix}`
  }
  if (isRightWorkspaceBrowserTab(tab)) {
    const browserState = browserStates[tab]
    return (
      browserState?.developmentPreview?.displayName ||
      browserState?.title ||
      t('workbench.browser_new_tab', '新选项卡')
    )
  }
  if (isRightWorkspaceChatTab(tab)) return t('workbench.workspace_tab_chat', '临时聊天')
  if (isRightWorkspaceHarnessTab(tab)) {
    return (
      harnessSessionsById.get(getRightWorkspaceHarnessSessionId(tab))?.title ??
      t('workbench.harness_session_picker_title', '新建编码会话')
    )
  }
  if (tab === 'plan') return t('workbench.workspace_tab_plan', '计划')
  if (tab === 'work-item') return t('workbench.work_item_detail', 'Issue 详情')
  return t('workbench.workspace_tab_files', '文件')
}

function getRightWorkspaceTabTestId(tab: RightWorkspacePanelTab) {
  if (isRightWorkspaceExtensionTab(tab)) {
    return `right-workspace-extension-tab-${tab.slice('dsh:'.length)}`
  }
  if (isRightWorkspaceTerminalTab(tab)) {
    const suffix = getRightWorkspaceTerminalTabSuffix(tab)
    return suffix === '1'
      ? 'right-workspace-terminal-tab'
      : `right-workspace-terminal-tab-${suffix}`
  }
  if (tab === 'files') return 'right-workspace-file-tab'
  if (isRightWorkspaceChatTab(tab)) {
    return `right-workspace-chat-tab-${getRightWorkspaceChatTabSuffix(tab)}`
  }
  if (isRightWorkspaceBrowserTab(tab)) {
    return `right-workspace-browser-tab-${getRightWorkspaceBrowserTabSuffix(tab)}`
  }
  if (isRightWorkspaceHarnessTab(tab)) {
    return `right-workspace-harness-tab-${getRightWorkspaceHarnessSessionId(tab)}`
  }
  return `right-workspace-${tab}-tab`
}

function getRightWorkspaceTabIcon(tab: RightWorkspacePanelTab) {
  if (isRightWorkspaceExtensionTab(tab)) return PanelRight
  if (tab === 'review') return FileDiff
  if (isRightWorkspaceTerminalTab(tab)) return SquareTerminal
  if (isRightWorkspaceBrowserTab(tab)) return Globe2
  if (isRightWorkspaceChatTab(tab)) return MessageCircle
  if (isRightWorkspaceHarnessTab(tab)) return SquareTerminal
  if (tab === 'plan') return ListChecks
  if (tab === 'work-item') return LayoutDashboard
  return File
}
