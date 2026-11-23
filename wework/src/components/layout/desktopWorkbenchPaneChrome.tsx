import { SubagentEnvironmentSummary } from '@/components/chat/SubagentConversationPanel'
import {
  TITLEBAR_ACTIONS_PORTAL_ID,
  TITLEBAR_RIGHT_PANEL_PORTAL_ID,
  WORKBENCH_SPLIT_ACTIONS_PORTAL_ID,
} from '@/components/topnav/TitlebarActionsPortal'
import { Tooltip } from '@/components/ui/tooltip'
import { DshMenuActions } from '@/features/dsh-runtime/DshMenuActions'
import {
  openFeedbackDialog,
  withLatestFeedbackDialogContext,
} from '@/features/feedback/feedbackDialogStore'
import { cn } from '@/lib/utils'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Archive, ArrowLeftRight, MessageSquareWarning, X } from 'lucide-react'
import { BackgroundTerminalsSummary } from './BackgroundTerminalsSummary'
import { ConversationHeaderTitle } from './ConversationHeaderTitle'
import { DESKTOP_TOP_BAR_BUTTON_CLASS } from './DesktopTopBar'
import { DesktopWindowControls } from './DesktopWindowControls'
import { MACOS_COLLAPSED_SIDEBAR_CONTROL_ALIGNMENT_CLASS } from './desktopWorkbenchMainHelpers'
import { MacOSTitleBarDragRegion } from './MacOSTitleBarDragRegion'
import type { useDesktopWorkbenchPaneModel } from './useDesktopWorkbenchPaneModel'
import { EnvironmentInfoPopover } from './EnvironmentInfoPopover'
import {
  WorkspacePanelToggles,
  WorkspaceTargetActions,
} from './workspace-panels/WorkspacePanelActions'
import { WorkspaceToolbarExtensions } from './workspace-panels/WorkspaceToolbarExtensions'
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
  const mainHeaderEnvironmentAction = currentRuntimeTask ? (
    <EnvironmentInfoPopover
      key={environmentInfoDocked ? 'docked' : 'floating'}
      info={environmentInfo}
      isGitRepository={conversationSummaryIsGitRepository}
      messages={paneMessages}
      popoverContainer={environmentInfoPanelElement}
      docked={environmentInfoDocked}
      open={environmentInfoOpen}
      onOpenChange={setEnvironmentInfoOpen}
      footer={
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
      devices={devices}
      onRefresh={refreshEnvironmentInfo}
      onCommitChanges={commitEnvironmentChanges}
      onCommitAndPushChanges={commitAndPushEnvironmentChanges}
      onPushChanges={pushEnvironmentChanges}
      onListBranches={listEnvironmentBranches}
      onCheckoutBranch={checkoutEnvironmentBranch}
      onCreateBranch={createEnvironmentBranch}
      onGenerateBranchName={branchNameApi ? generateBranchName : undefined}
      branchNameSource={workbenchTitle ?? undefined}
      onOpenChangesReview={openDefaultEnvironmentChangesReview}
      onOpenWorkspaceFile={openWorkspaceFileFromMessage}
      onDeliver={boundProjectSpaceApi && activeDeliveryItem ? openDelivery : undefined}
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
    />
  ) : null
  const mainHeaderProjectAction = (
    <WorkspaceTargetActions
      currentProject={currentProject}
      devices={devices}
      workspaceTarget={workspaceTarget}
      workspaceSessionApi={workspaceSessionApi}
    />
  )
  const panelChromeActions = (
    <WorkspacePanelToggles
      rightPanelOpen={rightPanelOpen}
      rightPanelExpanded={rightPanelExpanded}
      bottomPanelOpen={bottomPanelOpen}
      onToggleRightPanel={toggleRightPanel}
      onToggleRightPanelExpanded={toggleRightPanelExpanded}
      onToggleBottomPanel={toggleBottomPanel}
    />
  )
  const workspacePanelActions = !isDesktop ? (
    <>
      <WorkspaceToolbarExtensions
        currentProject={currentProject}
        environmentInfo={environmentInfo}
        workspaceTarget={workspaceTarget}
      />
      {mainHeaderEnvironmentAction}
      {mainHeaderProjectAction}
      {panelChromeActions}
    </>
  ) : null
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
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="fork-runtime-task-button"
        className={DESKTOP_TOP_BAR_BUTTON_CLASS}
        aria-label={t('workbench.task_fork_button')}
        onClick={() => setForkDialogOpen(true)}
      >
        <ArrowLeftRight />
      </ControlButton>
    </Tooltip>
  ) : undefined
  const feedbackButton = isDesktop ? (
    <Tooltip
      label={t('workbench.feedback_button')}
      side="bottom"
      align="end"
      testId="task-feedback-button-tooltip"
    >
      <ControlButton
        variant="unstyled"
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
      </ControlButton>
    </Tooltip>
  ) : undefined
  const closeHarnessButton =
    activeLocalHarnessSession?.harnessId === 'opencode' ? (
      <Tooltip label={t('workbench.archive_harness', '归档编码会话')} side="bottom" align="end">
        <ControlButton
          variant="unstyled"
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
        </ControlButton>
      </Tooltip>
    ) : activeLocalHarnessSession && !activeLocalHarnessSession.isPrimary ? (
      <Tooltip label={t('workbench.close_harness', '关闭编码工具')} side="bottom" align="end">
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="central-harness-close-button"
          className={DESKTOP_TOP_BAR_BUTTON_CLASS}
          aria-label={t('workbench.close_harness', '关闭编码工具')}
          onClick={() => {
            void onLocalHarnessSessionClose(activeLocalHarnessSession.sessionId)
          }}
        >
          <X />
        </ControlButton>
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
