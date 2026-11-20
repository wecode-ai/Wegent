import { McpAppPanelSlot } from '@/features/mcp-apps/McpAppPanelSlot'
import { isMcpAppPanelTab, useMcpAppPanels } from '@/features/mcp-apps/workspacePanels'
import { isQuestionDiscussionTab } from '@/features/notifications/questionDiscussion'
import { QuestionDiscussionTabPanel } from '@/features/notifications/QuestionDiscussionScope'
import { TabsList, TabsRoot } from '@wegent/collaboration/controls/Tabs'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import {
  File,
  FileDiff,
  Globe2,
  LayoutDashboard,
  MessageCircle,
  PanelRight,
  Plus,
  Puzzle,
  RefreshCw,
  SquareTerminal,
} from 'lucide-react'
import { revealWorkspaceTab } from './revealWorkspaceTab'
import type { RightWorkspaceTerminalTab } from './RightWorkspacePanel.types'
import { createRightWorkspaceExtensionCatalog } from './rightWorkspacePanelState'

import {
  memo,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { FileChangesReviewPanel } from '@/components/chat/FileChangesReviewPanel'

import { CentralHarnessTerminal } from '@/components/layout/CentralHarnessTerminal'

import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { TitlebarRightPanelPortal } from '@/components/topnav/TitlebarActionsPortal'
import { SmartAppPluginDialog } from '@/features/harness-apps/SmartAppPluginDialog'

import { useTranslation } from '@/hooks/useTranslation'

import { reloadEmbeddedBrowser } from '@/lib/embedded-browser'
import { getPlatform } from '@/lib/platform'
import { isDesktopRuntime } from '@/lib/runtime-environment'
import { cn } from '@/lib/utils'

import { FileWorkspacePanel, type FileWorkspacePanelHandle } from './FileWorkspacePanel'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { isWorkspaceFileTab } from './workspaceFileTabs'

import { WorkspacePanelCards } from './WorkspacePanelCards'

import { BackgroundTerminalPanel } from './BackgroundTerminalPanel'
import { TemporaryChatPanel } from './TemporaryChatPanel'

import { DshSidebarExtensionPanel } from './DshSidebarExtensionPanel'

import {
  isRightWorkspaceExtensionTab,
  resolveRightWorkspaceExtensionDescriptor,
  rightWorkspaceDshSidebar,
  titleOfWeworkWorkspaceSidebarTab,
} from './rightWorkspaceDshSidebar'
import type {
  RightWorkspaceBrowserTab,
  RightWorkspacePanelProps,
  RightWorkspacePanelTab,
} from './RightWorkspacePanel.types'

import {
  PlanWorkspacePanel,
  RightWorkspaceBrowserPanelSlot,
  RightWorkspaceLauncher,
  RightWorkspaceTitleTab,
  SmartAppDevelopmentPreviewState,
  SmartAppDevelopmentVerification,
} from './RightWorkspacePanelParts'

import {
  getRightWorkspaceChatTabSuffix,
  getRightWorkspaceHarnessSessionId,
  getRightWorkspaceShortcuts,
  getRightWorkspaceTabIcon,
  getRightWorkspaceTabLabel,
  isRightWorkspaceBrowserTab,
  isRightWorkspaceChatTab,
  isRightWorkspaceHarnessTab,
  isRightWorkspaceTerminalTab,
  requestIdForWorkspaceFileTab,
} from './rightWorkspacePanelHelpers'

export type {
  RightWorkspaceBackgroundTerminalTab,
  RightWorkspaceBrowserState,
  RightWorkspaceBrowserTab,
  RightWorkspaceChatTab,
  RightWorkspaceHarnessTab,
  RightWorkspacePanelHandle,
  RightWorkspacePanelTab,
  RightWorkspacePanelView,
  RightWorkspaceTerminalTab,
} from './RightWorkspacePanel.types'

export const RightWorkspacePanel = memo(function RightWorkspacePanel({
  ref,
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
  fileTabs = {},
  onOpenFileTab,
  workspaceTargetError,
  review,
  planContent,
  subagentPanel,
  backgroundTerminals = [],
  workItemPanel,
  extensionTabs = {},
  extensionScope,
  browserStates,
  browserTransferSourceLabels = {},
  onBrowserStateChange,
  onReloadSmartAppDevelopmentPreview,
  onAddSmartAppDevelopmentPlugin,
  onVerifySmartAppDevelopmentPreview,
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
  onOpenWorkspaceFile,
  onOpenReviewSourceFile,
  onApplyReviewPatch,
  onRestoreConversation,
  getChatInitialInput,
  getChatInitialAddress,
  onChatAddressChange,
}: RightWorkspacePanelProps) {
  const { t } = useTranslation('common')
  const mcpAppPanels = useMcpAppPanels(currentRuntimeTask)
  const filePanelRef = useRef<FileWorkspacePanelHandle>(null)
  const activeFileTab = isWorkspaceFileTab(activeView) ? fileTabs[activeView] : undefined
  const activeFilePanelTarget = activeFileTab?.target ?? fileWorkspaceTarget
  const activeFileOpenRequest =
    activeFileTab && isWorkspaceFileTab(activeView)
      ? (activeFileTab.openRequest ?? {
          id: requestIdForWorkspaceFileTab(activeView),
          path: activeFileTab.path,
        })
      : null
  const fileViewActive = activeView === 'files' || Boolean(activeFileTab)
  const primaryFilePath =
    openFileRequest?.attachment?.filename ??
    (initialFileSelection
      ? initialFileSelection.isDirectory
        ? undefined
        : initialFileSelection.path
      : openFileRequest && !openFileRequest.isDirectory
        ? openFileRequest.path
        : undefined)
  const navigateFromFile = useCallback((action: () => void) => {
    if (filePanelRef.current) filePanelRef.current.navigate(action)
    else action()
  }, [])
  useImperativeHandle(ref, () => ({ navigate: navigateFromFile }), [navigateFromFile])
  const extensionCatalog = useMemo(
    () => createRightWorkspaceExtensionCatalog(extensionScope.cwd ?? null),
    [extensionScope.cwd]
  )
  const subscribeExtensions = useCallback(
    (listener: () => void) =>
      extensionCatalog.subscribe(listener, { openTabs, extensionTabs, onCloseTab }),
    [extensionCatalog, openTabs, extensionTabs, onCloseTab]
  )
  const { availableTabs: availableExtensionTabs } = useSyncExternalStore(
    subscribeExtensions,
    extensionCatalog.getSnapshot,
    extensionCatalog.getSnapshot
  )
  const [pluginDialog, setPluginDialog] = useState<{
    tab: RightWorkspaceBrowserTab
    installationId: string
    displayName: string
  } | null>(null)
  const availableTabs = allowTemporaryChat
    ? openTabs
    : openTabs.filter(tab => !isRightWorkspaceChatTab(tab))
  const visibleTabs = availableTabs.filter(tab =>
    isWorkspaceFileTab(tab) ? Boolean(fileTabs[tab]) : canBrowseFiles || tab !== 'files'
  )
  const showTabs = visibleTabs.length > 0
  const platform = getPlatform()
  const renderTabsInTitlebar =
    renderTabsInAppTitlebar && isDesktopRuntime() && platform !== 'win' && visible && showTabs
  const bindTabsViewport = useCallback(
    (viewport: HTMLDivElement | null) => {
      if (!visible || !showTabs || activeView === 'launcher') return
      revealWorkspaceTab(viewport)
    },
    [activeView, visible, showTabs]
  )
  const harnessSessionsById = new Map(
    harnessSessions.map(session => [session.sessionId, session] as const)
  )

  const closeTab = (tab: RightWorkspacePanelTab) => {
    if (tab === activeView) navigateFromFile(() => onCloseTab(tab))
    else onCloseTab(tab)
  }

  const getTabSelectHandler =
    (tab: RightWorkspacePanelTab): (() => void) =>
    () =>
      navigateFromFile(() => onSelectTab(tab))

  const getNewTabOptions = (): WorkspaceAddMenuItem[] => [
    ...workspaceActions,
    ...[...availableExtensionTabs]
      .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
      .map(
        (descriptor): WorkspaceAddMenuItem => ({
          id: `wework-sidebar-extension:${descriptor.id}`,
          testId: `right-workspace-extension-option-${descriptor.id}`,
          icon: PanelRight,
          label: titleOfWeworkWorkspaceSidebarTab(descriptor, t),
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
    <TabsRoot
      value={activeView === 'launcher' ? null : getRightWorkspaceTabTestId(activeView)}
      onValueChange={next => {
        const tab = visibleTabs.find(tab => getRightWorkspaceTabTestId(tab) === next)
        if (tab) getTabSelectHandler(tab)()
      }}
      render={<div className="contents" />}
    >
      <TabsList
        render={<header />}
        data-testid="right-workspace-tabbar"
        className={cn(
          'electron-titlebar-interactive-region relative z-chrome flex min-w-0 shrink-0 items-center pointer-events-auto',
          renderTabsInTitlebar
            ? 'h-[38px] w-full gap-1 bg-transparent pl-4'
            : cn(
                'h-10 gap-1.5 px-3',
                platform === 'win' ? '' : 'border-b border-border',
                showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
              )
        )}
      >
        <div
          ref={bindTabsViewport}
          data-testid="right-workspace-tabs-viewport"
          className="flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden scrollbar-none"
        >
          {visibleTabs.map(tab => (
            <RightWorkspaceTitleTab
              key={tab}
              tab={tab}
              active={activeView === tab}
              title={backgroundTerminals.find(terminal => terminal.tabId === tab)?.command}
              filePath={
                isWorkspaceFileTab(tab)
                  ? fileTabs[tab]?.path
                  : tab === 'files'
                    ? primaryFilePath
                    : undefined
              }
              label={getRightWorkspaceTabLabel(
                tab,
                t,
                browserStates,
                harnessSessionsById,
                extensionTabs,
                backgroundTerminals
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
        </div>
        <div className="relative shrink-0">
          {visible ? (
            <WorkspaceAddMenu
              ariaLabel={t('workbench.workspace_tab_new', '打开新标签页')}
              buttonTestId="right-workspace-new-tab-button"
              menuTestId="right-workspace-new-tab-menu"
              items={getNewTabOptions()}
              buttonClassName="flex shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary pointer-events-auto"
            />
          ) : (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="right-workspace-new-tab-button"
              disabled
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary opacity-50"
              aria-label={t('workbench.workspace_tab_new', '打开新标签页')}
            >
              <Plus className="h-4 w-4" />
            </ControlButton>
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
      </TabsList>
    </TabsRoot>
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
            extensionTabs={availableExtensionTabs}
            onSelectReview={onSelectReview}
            onSelectTerminal={onSelectTerminal}
            onSelectBrowser={onSelectBrowser}
            onSelectFiles={onSelectFiles}
            onSelectChat={onSelectChat}
            showWorkbenchBackground={showWorkbenchBackground}
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
            reviewMode={review.reviewMode}
            viewOptions={reviewViewOptions}
            onRefresh={onRefreshReview}
            onOpenSourceFile={onOpenReviewSourceFile}
            onApplyPatch={onApplyReviewPatch}
            onAddCodeComment={onAddCodeComment}
          />
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'plan' ? (
          <PlanWorkspacePanel
            content={planContent ?? ''}
            showWorkbenchBackground={showWorkbenchBackground}
          />
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'subagents' ? (
          subagentPanel
        ) : !isRightWorkspaceChatTab(activeView) && activeView === 'work-item' ? (
          workItemPanel
        ) : activeView === 'files' && workspaceTargetError ? (
          <section
            data-testid="workspace-target-error"
            className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-destructive wework:text-red-500"
          >
            {workspaceTargetError}
          </section>
        ) : (
          !isRightWorkspaceChatTab(activeView) &&
          canBrowseFiles &&
          fileViewActive && (
            <FileWorkspacePanel
              ref={filePanelRef}
              key={
                activeFilePanelTarget
                  ? `${activeFilePanelTarget.deviceId}:${activeFilePanelTarget.path}`
                  : 'empty'
              }
              target={activeFilePanelTarget}
              workspaceTargets={fileWorkspaceTargets}
              workspaceFileApi={workspaceFileApi}
              openFileRequest={activeFileOpenRequest ?? openFileRequest}
              initialSelection={activeFileTab ? null : initialFileSelection}
              onAddCodeComment={onAddCodeComment}
              onDirtyChange={onFileDirtyChange}
              onSelectionChange={activeFileTab ? undefined : onFileSelectionChange}
              onSelectWorkspaceTarget={onSelectFileWorkspaceTarget}
              onOpenFileTab={onOpenFileTab}
            />
          )
        )}
        {openTabs
          .filter(tab => tab.startsWith('background-terminal:'))
          .map(tab => (
            <div
              key={tab}
              className={cn(
                'min-h-0 min-w-0 flex-1 flex-col',
                activeView === tab ? 'flex' : 'hidden'
              )}
            >
              <BackgroundTerminalPanel
                terminal={backgroundTerminals.find(terminal => terminal.tabId === tab)}
                active={visible && activeView === tab}
              />
            </div>
          ))}
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
              showWorkbenchBackground={showWorkbenchBackground}
              onRestoreConversation={onRestoreConversation}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
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
              className={cn(
                'min-h-0 min-w-0 flex-1 flex-col',
                activeView === tab ? 'flex' : 'hidden'
              )}
            >
              {developmentPreview ? (
                <section
                  data-testid="smart-app-development-preview"
                  className="flex min-h-0 min-w-0 flex-1 flex-col"
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
                    <div className="relative flex shrink-0 items-center justify-end gap-1">
                      <SmartAppDevelopmentVerification
                        disabled={developmentPreview.status !== 'ready'}
                        preview={developmentPreview}
                        tab={tab}
                        onVerify={onVerifySmartAppDevelopmentPreview}
                      />
                      <ControlButton
                        variant="unstyled"
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
                      </ControlButton>
                      <ControlButton
                        variant="unstyled"
                        type="button"
                        data-testid="smart-app-development-preview-refresh"
                        disabled={developmentPreview.status !== 'ready'}
                        onClick={() => void reloadEmbeddedBrowser(browserState.label)}
                        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {t('workbench.smart_app_preview_refresh')}
                      </ControlButton>
                      <ControlButton
                        variant="outline"
                        size="sm"
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
                      </ControlButton>
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
        {openTabs.filter(isQuestionDiscussionTab).map(tab => (
          <div
            key={tab}
            className={cn('min-h-0 flex-1 flex-col', activeView === tab ? 'flex' : 'hidden')}
          >
            <QuestionDiscussionTabPanel
              tab={tab}
              active={visible && activeView === tab}
              onClose={() => onCloseTab(tab)}
            />
          </div>
        ))}
        {mcpAppPanels
          .filter(panel => openTabs.includes(panel.id))
          .map(panel => (
            <div
              key={panel.id}
              className={cn('min-h-0 flex-1 flex-col', activeView === panel.id ? 'flex' : 'hidden')}
            >
              <McpAppPanelSlot panel={panel} />
            </div>
          ))}
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

function getRightWorkspaceTabTestId(tab: RightWorkspacePanelTab) {
  if (isMcpAppPanelTab(tab)) return `right-workspace-mcp-app-tab-${tab.slice(8)}`
  if (isQuestionDiscussionTab(tab)) return `right-workspace-discussion-tab-${tab.slice(11)}`
  if (isWorkspaceFileTab(tab)) return `right-workspace-file-tab-${tab.slice('file:'.length)}`
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
function getRightWorkspaceBrowserTabSuffix(tab: RightWorkspaceBrowserTab) {
  return tab.slice('browser:'.length)
}

function getRightWorkspaceTerminalTabSuffix(tab: RightWorkspaceTerminalTab) {
  return tab.slice('terminal:'.length)
}
