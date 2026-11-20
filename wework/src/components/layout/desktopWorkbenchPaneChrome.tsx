import { BackgroundTerminalsSummary } from './BackgroundTerminalsSummary'
import { Archive, ArrowLeftRight, MessageSquareWarning, X } from 'lucide-react'
import { SubagentEnvironmentSummary } from '@/components/chat/SubagentConversationPanel'
import { cn } from '@/lib/utils'
import { WorkspacePanelActions } from './workspace-panels/WorkspacePanelActions'
import { WorkspaceToolbarExtensions } from './workspace-panels/WorkspaceToolbarExtensions'
import { DshMenuActions } from '@/features/dsh-runtime/DshMenuActions'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
  WORKBENCH_SPLIT_ACTIONS_PORTAL_ID,
} from '@/components/topnav/TitlebarActionsPortal'
import { Tooltip } from '@/components/ui/tooltip'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import { ConversationHeaderTitle } from './ConversationHeaderTitle'
import {
  openFeedbackDialog,
  withLatestFeedbackDialogContext,
} from '@/features/feedback/feedbackDialogStore'
import { MACOS_COLLAPSED_SIDEBAR_CONTROL_ALIGNMENT_CLASS } from './desktopWorkbenchMainHelpers'
import type { useDesktopWorkbenchPaneModel } from './useDesktopWorkbenchPaneModel'
export function createDesktopWorkbenchPaneChrome(
  model: ReturnType<typeof useDesktopWorkbenchPaneModel>
) {
  const {
    presentation,
    sidebarCollapsed,
    workspaceSessionApi,
    onSidebarCollapsedChange,
    activeLocalHarnessSession,
    onLocalHarnessSessionClose,
    experimentalFeaturesEnabled,
    background,
    forkCurrentRuntimeTask,
    startNewChat,
    t,
    currentRuntimeTask,
    currentProject,
    currentRuntimeProjectWork,
    paneKey,
    runtimeTaskSummary,
    currentRuntimeConversationSource,
    workbenchTitle,
    feedbackDialogRequest,
    activeDeliveryItem,
    boundCloudItem,
    boundCloudProject,
    boundProjectSpaceApi,
    openDelivery,
    issueExecutionReadOnly,
    supervisor,
    supervisorFeatureAvailable,
    runTaskSupervisorNow,
    workspaceTarget,
    environmentInfo,
    conversationSummaryIsGitRepository,
    refreshEnvironmentInfo,
    commitEnvironmentChanges,
    commitAndPushEnvironmentChanges,
    pushEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    devices,
    feedbackDialogRequestRef,
    rightPanelOpen,
    rightPanelExpanded,
    subagentConversations,
    setForkDialogOpen,
    isDesktop,
    environmentInfoPanelElement,
    environmentInfoDocked,
    environmentInfoOpen,
    setEnvironmentInfoOpen,
    openSupervisorDialog,
    paneTitleWidth,
    rightTitlebarActionsWidth,
    rightPanelTabBarWidth,
    bottomPanelOpen,
    paneMessages,
    currentRuntimeUsesCodex,
    branchNameApi,
    generateBranchName,
    runningBackgroundTerminals,
    openBackgroundTerminal,
    stopBackgroundTerminals,
    openSubagentOverview,
    openDefaultEnvironmentChangesReview,
    openWorkspaceFileFromMessage,
    toggleRightPanel,
    toggleRightPanelExpanded,
    toggleBottomPanel,
  } = model
  const renderWorkspacePanelActions = (
    mode:
      | 'all'
      | 'environment'
      | 'primary-target'
      | 'panel-toggles'
      | 'bottom-panel-toggle'
      | 'right-panel-toggle',
    environmentInfoPopoverContainer: HTMLElement | null = environmentInfoPanelElement,
    forceEnvironmentInfoDocked?: boolean
  ) => (
    <WorkspacePanelActions
      mode={mode}
      currentProject={currentProject}
      devices={devices}
      workspaceTarget={workspaceTarget}
      workspaceSessionApi={workspaceSessionApi}
      environmentInfo={environmentInfo}
      conversationSummaryIsGitRepository={conversationSummaryIsGitRepository}
      conversationMessages={paneMessages}
      environmentInfoPopoverContainer={environmentInfoPopoverContainer}
      environmentInfoVisible={Boolean(currentRuntimeTask)}
      environmentInfoDocked={forceEnvironmentInfoDocked ?? environmentInfoDocked}
      environmentInfoOpen={environmentInfoOpen}
      onEnvironmentInfoOpenChange={setEnvironmentInfoOpen}
      environmentInfoFooter={
        subagentConversations.length > 0 || runningBackgroundTerminals.length > 0 ? (
          <div className="flex flex-col gap-3">
            <SubagentEnvironmentSummary
              blocks={subagentConversations}
              onOpen={openSubagentOverview}
            />
            <BackgroundTerminalsSummary
              terminals={runningBackgroundTerminals}
              onOpen={openBackgroundTerminal}
              onStop={stopBackgroundTerminals}
            />
          </div>
        ) : undefined
      }
      onRefreshEnvironmentInfo={refreshEnvironmentInfo}
      onCommitEnvironmentChanges={commitEnvironmentChanges}
      onCommitAndPushEnvironmentChanges={commitAndPushEnvironmentChanges}
      onPushEnvironmentChanges={pushEnvironmentChanges}
      onListEnvironmentBranches={listEnvironmentBranches}
      onCheckoutEnvironmentBranch={checkoutEnvironmentBranch}
      onCreateEnvironmentBranch={createEnvironmentBranch}
      onGenerateEnvironmentBranch={branchNameApi ? generateBranchName : undefined}
      environmentBranchNameSource={workbenchTitle ?? undefined}
      onOpenEnvironmentChangesReview={openDefaultEnvironmentChangesReview}
      onOpenConversationWorkspaceFile={path => void openWorkspaceFileFromMessage(path)}
      onDeliver={
        currentRuntimeTask && boundProjectSpaceApi && activeDeliveryItem ? openDelivery : undefined
      }
      todoLabel={
        boundCloudItem ? `${boundCloudItem.id} · ${boundCloudItem.title}` : boundCloudProject?.name
      }
      supervisor={supervisorFeatureAvailable ? supervisor : null}
      onConfigureSupervisor={
        !issueExecutionReadOnly && supervisorFeatureAvailable && supervisor
          ? openSupervisorDialog
          : undefined
      }
      onRunSupervisorNow={
        !issueExecutionReadOnly && supervisorFeatureAvailable && supervisor
          ? runTaskSupervisorNow
          : undefined
      }
      rightPanelOpen={rightPanelOpen}
      rightPanelExpanded={rightPanelExpanded}
      bottomPanelOpen={bottomPanelOpen}
      onToggleRightPanel={toggleRightPanel}
      onToggleRightPanelExpanded={toggleRightPanelExpanded}
      onToggleBottomPanel={toggleBottomPanel}
    />
  )
  const workspacePanelActions = renderWorkspacePanelActions('all')
  const conversationToolbarExtensions = currentRuntimeTask ? (
    <DshMenuActions
      args={{
        deviceId: currentRuntimeTask.deviceId,
        taskId: currentRuntimeTask.taskId,
        workspacePath: currentRuntimeConversationSource?.workspacePath,
      }}
      buttonClassName={DESKTOP_TOP_BAR_BUTTON_CLASS}
      location="conversation.toolbar"
    />
  ) : null
  const workspaceToolbarExtensions = (
    <>
      {conversationToolbarExtensions}
      <WorkspaceToolbarExtensions
        currentProject={currentProject}
        environmentInfo={environmentInfo}
        workspaceTarget={workspaceTarget}
      />
    </>
  )
  const mainHeaderProjectAction = renderWorkspacePanelActions('primary-target')
  const mainHeaderEnvironmentAction = renderWorkspacePanelActions('environment')
  const panelChromeActions = renderWorkspacePanelActions('panel-toggles')
  const conversationHeaderTitle =
    currentRuntimeConversationSource && runtimeTaskSummary && !activeLocalHarnessSession ? (
      <ConversationHeaderTitle
        key={paneKey}
        title={runtimeTaskSummary.title}
        displayTitle={workbenchTitle ?? runtimeTaskSummary.title}
        address={currentRuntimeConversationSource}
        projectWork={currentRuntimeProjectWork}
      />
    ) : (
      <span className="block min-w-0 truncate">{workbenchTitle}</span>
    )
  const paneTaskTitle =
    workbenchTitle && !isDesktop ? (
      <div
        data-testid="workbench-pane-task-title"
        className={cn(
          'pointer-events-none absolute left-0 top-0 z-chrome flex h-11 min-w-0 truncate items-center pr-7 text-sm font-medium leading-none text-text-primary',
          sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
          'transition-none'
        )}
        style={{ width: paneTitleWidth }}
      >
        {conversationHeaderTitle}
      </div>
    ) : undefined
  const topBarLeftActions = !isDesktop ? (
    sidebarCollapsed ? (
      <DesktopWindowControls
        sidebarCollapsed
        onToggleSidebar={() => onSidebarCollapsedChange(false)}
        onNewChat={startNewChat}
      />
    ) : (
      <DesktopWindowControls
        sidebarCollapsed={false}
        onToggleSidebar={() => onSidebarCollapsedChange(true)}
      />
    )
  ) : undefined
  const topBarLeftContent = topBarLeftActions ? <>{topBarLeftActions}</> : undefined
  const canForkCurrentRuntimeTask = Boolean(
    !issueExecutionReadOnly &&
    experimentalFeaturesEnabled &&
    currentRuntimeTask &&
    currentRuntimeUsesCodex &&
    forkCurrentRuntimeTask
  )
  const forkTaskButton = canForkCurrentRuntimeTask ? (
    <Tooltip label={t('workbench.task_fork_button')} side="bottom" align="end">
      <button
        type="button"
        data-testid="fork-runtime-task-button"
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.task_fork_button')}
        onClick={() => setForkDialogOpen(true)}
      >
        <ArrowLeftRight />
      </button>
    </Tooltip>
  ) : undefined
  const feedbackButton = isDesktop ? (
    <Tooltip
      label={t('workbench.feedback_button')}
      side="bottom"
      align="end"
      testId="task-feedback-button-tooltip"
    >
      <button
        type="button"
        data-testid="task-feedback-button"
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.feedback_button')}
        onClick={() =>
          openFeedbackDialog(
            withLatestFeedbackDialogContext(
              feedbackDialogRequest,
              () => feedbackDialogRequestRef.current
            )
          )
        }
      >
        <MessageSquareWarning />
      </button>
    </Tooltip>
  ) : undefined
  const closeHarnessButton =
    activeLocalHarnessSession?.harnessId === 'opencode' ? (
      <Tooltip label={t('workbench.archive_harness', '归档编码会话')} side="bottom" align="end">
        <button
          type="button"
          data-testid={
            activeLocalHarnessSession.isPrimary
              ? 'central-harness-archive-button'
              : 'central-harness-close-button'
          }
          className={DESKTOP_TOP_BAR_BUTTON_CLASS}
          aria-label={t('workbench.archive_harness', '归档编码会话')}
          onClick={() => {
            void onLocalHarnessSessionClose(activeLocalHarnessSession.sessionId)
          }}
        >
          <Archive />
        </button>
      </Tooltip>
    ) : activeLocalHarnessSession && !activeLocalHarnessSession.isPrimary ? (
      <Tooltip label={t('workbench.close_harness', '关闭编码工具')} side="bottom" align="end">
        <button
          type="button"
          data-testid="central-harness-close-button"
          className={DESKTOP_TOP_BAR_BUTTON_CLASS}
          aria-label={t('workbench.close_harness', '关闭编码工具')}
          onClick={() => {
            void onLocalHarnessSessionClose(activeLocalHarnessSession.sessionId)
          }}
        >
          <X />
        </button>
      </Tooltip>
    ) : undefined
  const feedbackInChromeTitlebar = isDesktop
  const mainHeaderActions = activeLocalHarnessSession ? (
    <>
      {workspaceToolbarExtensions}
      {closeHarnessButton}
    </>
  ) : (
    <>
      {forkTaskButton}

      {!feedbackInChromeTitlebar && feedbackButton}
      {workspaceToolbarExtensions}
      {mainHeaderProjectAction}
      {mainHeaderEnvironmentAction}
    </>
  )
  const topRightActions = isDesktop ? (
    <>{panelChromeActions}</>
  ) : activeLocalHarnessSession ? (
    <>
      {closeHarnessButton}
      {workspacePanelActions}
    </>
  ) : (
    <>
      {forkTaskButton}

      {workspacePanelActions}
    </>
  )
  const desktopMainHeaderContent = isDesktop ? (
    <div className="relative flex h-full min-w-0 flex-1 items-center overflow-hidden">
      <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
      {sidebarCollapsed && (
        <div
          data-testid="workbench-main-header-left-controls"
          className={cn(
            'electron-titlebar-interactive-region relative z-0 flex h-full shrink-0 items-center gap-1 pr-1',
            MACOS_COLLAPSED_SIDEBAR_CONTROL_ALIGNMENT_CLASS
          )}
        >
          <DesktopWindowControls
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => onSidebarCollapsedChange(!sidebarCollapsed)}
            className="gap-1"
          />
        </div>
      )}
      {workbenchTitle ? (
        <div
          data-testid="workbench-pane-task-title"
          className={cn(
            'pointer-events-none relative z-0 flex h-full min-w-0 flex-1 items-center truncate pl-4 text-sm font-medium leading-none text-text-primary',
            'transition-none'
          )}
        >
          {conversationHeaderTitle}
        </div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      <div
        data-testid="titlebar-main-actions"
        className={cn(
          'electron-titlebar-interactive-region relative z-0 flex h-full shrink-0 items-center justify-end gap-1 pr-1',
          rightPanelExpanded && 'invisible'
        )}
      >
        <div
          id={WORKBENCH_SPLIT_ACTIONS_PORTAL_ID}
          data-testid="workbench-split-actions"
          className="flex h-full shrink-0 items-center"
        />
        {mainHeaderActions}
      </div>
      <div
        aria-hidden="true"
        className={cn('shrink-0', 'transition-none')}
        style={{
          width: `calc(${rightPanelTabBarWidth} + ${rightTitlebarActionsWidth})`,
        }}
      />
      <div
        data-testid="titlebar-right-workspace-zone"
        className={cn(
          'pointer-events-none absolute top-0 z-chrome flex h-full min-w-0 items-center overflow-hidden',
          background.imagePath && background.inTopBar ? 'bg-transparent' : 'bg-background/95',
          rightPanelOpen && !rightPanelExpanded ? 'border-l border-border/60' : undefined,
          'transition-none'
        )}
        style={{
          right: rightTitlebarActionsWidth,
          width: rightPanelTabBarWidth,
        }}
      >
        <div
          id={TITLEBAR_RIGHT_PANEL_PORTAL_ID}
          data-testid="titlebar-right-panel"
          className="pointer-events-none flex h-full min-w-0 flex-1 items-center"
        />
      </div>
      <div
        id={TITLEBAR_ACTIONS_PORTAL_ID}
        data-testid="titlebar-actions"
        className={cn(
          'electron-titlebar-interactive-region pointer-events-auto absolute top-0 z-chrome flex h-full min-w-[5rem] items-center justify-end gap-1 pr-2',
          'transition-none'
        )}
        style={{
          right: '0px',
          width: rightTitlebarActionsWidth,
        }}
      >
        {topRightActions}
      </div>
    </div>
  ) : undefined
  const paneHeaderActions = activeLocalHarnessSession ? (
    <>
      {workspaceToolbarExtensions}
      {closeHarnessButton}
    </>
  ) : (
    <>
      {forkTaskButton}

      {workspaceToolbarExtensions}
      {mainHeaderProjectAction}
      {mainHeaderEnvironmentAction}
      {panelChromeActions}
    </>
  )
  const showPageTopBar =
    presentation !== 'popout' &&
    !isDesktop &&
    (Boolean(topBarLeftContent) || Boolean(paneTaskTitle))
  return {
    showPageTopBar,
    paneTaskTitle,
    topBarLeftContent,
    topRightActions,
    desktopMainHeaderContent,
    paneHeaderActions,
  }
}
export type DesktopWorkbenchPaneRenderModel = ReturnType<typeof useDesktopWorkbenchPaneModel> &
  ReturnType<typeof createDesktopWorkbenchPaneChrome>
