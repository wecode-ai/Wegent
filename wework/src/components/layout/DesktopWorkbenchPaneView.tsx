import { createDesktopWorkbenchPaneChrome } from './desktopWorkbenchPaneChrome'
import { DesktopWorkbenchConversationView } from './DesktopWorkbenchConversationView'
import { AttachmentPreviewContext } from '@/components/chat/AttachmentPreviewContext'
import { ImageEditProvider } from '@/components/chat/image-preview/ImageEditContext'
import { useImageEditSubmission } from './useImageEditSubmission'
import { memo, useCallback } from 'react'
import {
  SubagentConversationPanel,
  SubagentOverviewPanel,
} from '@/components/chat/SubagentConversationPanel'
import { DeliveryDialog } from '@/features/delivery/DeliveryDialog'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { getWorkbenchDeviceNamesById } from '@/lib/workbench-device'
import { cn } from '@/lib/utils'
import { BottomWorkspacePanel } from './workspace-panels/BottomWorkspacePanel'
import { RightWorkspacePanel } from './workspace-panels/RightWorkspacePanel'
import { WorkItemContextPanel } from '@/features/todo/WorkItemContextPanel'
import { TaskBoardAssociationDialog } from '@/features/todo/TaskBoardAssociationDialog'
import { RIGHT_SPLIT_PANEL_MIN_WIDTH } from './workspace-panels/useResizableWorkspacePanel'
import { LocalRuntimeNotice } from '@/features/local-runtime/LocalRuntimeNotice'
import {
  WorkbenchMainHeaderPortal,
  WorkbenchPaneHeaderActionsPortal,
} from '@/components/topnav/TitlebarActionsPortal'
import { DesktopTopBar } from './DesktopTopBar'
import { TaskForkDialog } from './TaskForkDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { type BottomPanelRenderContext } from './desktopWorkbenchPaneTypes'
import { TaskSupervisorControl } from './TaskSupervisorControl'
import { HarnessSessionPickerDialog } from './HarnessSessionPickerDialog'
import type { WorkspaceAddMenuItem } from './workspace-panels/WorkspaceAddMenu'
import { RIGHT_PANEL_SHELL_TRANSITION_CLASS } from './desktopWorkbenchMainHelpers'
import type { useDesktopWorkbenchPaneModel } from './useDesktopWorkbenchPaneModel'
const MemoizedBottomWorkspacePanel = memo(function MemoizedBottomWorkspacePanel({
  panelKey,
  open,
  active,
  paneVisible,
  context,
  workspaceSessionApi,
  showWorkbenchBackground,
  workspaceActions,
  onRequestClose,
  onTerminalTabsEmpty,
}: {
  panelKey: string
  open: boolean
  active: boolean
  paneVisible: boolean
  context: BottomPanelRenderContext
  workspaceSessionApi?: WorkspaceSessionApi
  showWorkbenchBackground: boolean
  workspaceActions?: WorkspaceAddMenuItem[]
  onRequestClose: (key: string) => void
  onTerminalTabsEmpty: () => void
}) {
  const closePanel = useCallback(() => onRequestClose(panelKey), [onRequestClose, panelKey])

  return (
    <BottomWorkspacePanel
      open={open && paneVisible}
      active={active && paneVisible}
      preserveContent
      testIdsEnabled={active && paneVisible}
      currentProject={context.currentProject}
      devices={context.devices}
      workspaceTarget={context.workspaceTarget}
      preferLocalTerminal={context.preferLocalTerminal}
      terminalContextTitle={context.terminalContextTitle}
      workspaceSessionApi={workspaceSessionApi}
      showWorkbenchBackground={showWorkbenchBackground}
      workspaceActions={workspaceActions}
      onRequestClose={closePanel}
      onTerminalTabsEmpty={onTerminalTabsEmpty}
    />
  )
})
export function DesktopWorkbenchPaneView({
  model: baseModel,
}: {
  model: ReturnType<typeof useDesktopWorkbenchPaneModel>
}) {
  const model = { ...baseModel, ...createDesktopWorkbenchPaneChrome(baseModel) }
  const imageEditSubmission = useImageEditSubmission({
    enabled: model.paneVisible && !model.issueExecutionReadOnly && !model.composerDisabled,
    scope: model.paneSession.scopeKey,
    upload: model.services.attachmentApi?.uploadAttachment,
    submit: model.submitPaneInput,
    replaceImageAttachment: model.projectChat.replaceImageAttachmentForScope,
    removeDraftAttachment: model.projectChat.removeAttachmentForScope,
  })
  const {
    workbenchVisible,
    sidebarCollapsed,
    sidebarResizing,
    presentation,
    workspaceSessionApi,
    localHarnessSessions,
    onLocalHarnessSessionExit,
    paneActive,
    paneVisible,
    paneHeaderActionsPortalId,
    splitMode,
    appPreferences,
    background,
    state,
    workspaceFileApi,
    projectChat,
    forkCurrentRuntimeTask,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    services,
    openRuntimeTask,
    t,
    harnessSessionPickerTarget,
    setHarnessSessionPickerTarget,
    currentRuntimeTask,
    currentProject,
    setTurnNavigationPortalTarget,
    paneSession,
    fileOpenError,
    setFileOpenError,
    additionalHarnessError,
    setAdditionalHarnessError,
    pendingSupervisorConfig,
    supervisorDialogScopeKey,
    setSupervisorDialogTaskKey,
    supervisorDialogOpen,
    runtimeWork,
    currentRuntimeConversationSource,
    currentProjectSpaceRuntimeTask,
    runtimeTaskTitle,
    workbenchTitle,
    activeDeliveryItem,
    associateRuntimeTaskWithExistingItem,
    associateRuntimeTaskWithNewItem,
    boundCloudItem,
    boundCloudProject,
    boundProjectSpaceApi,
    clearCloudActionNotice,
    closeTaskBoardAssociation,
    clearTodoBindingError,
    closeDeliveryDialog,
    cloudActionNotice,
    deliveryDialogOpen,
    finishDelivery,
    openBoundProjectSpaceTask,
    taskBoardAssociation,
    todoBindingError,
    workItemContextAvailable,
    issueExecutionReadOnly,
    supervisor,
    setTaskSupervisor,
    clearTaskSupervisor,
    runTaskSupervisorNow,
    workspaceProject,
    workspaceTarget,
    workspaceTargetError,
    loadEnvironmentDiff,
    devices,
    browserTransferSourceLabels,
    temporaryChatInitialInputsRef,
    rightPanelOpen,
    rightPanelExpanded,
    rightPanelExtensionTabs,
    temporaryChatAddresses,
    fileTabs,
    reviewState,
    browserStates,
    setRightPanelExpanded,
    setSelectedSubagentConversationId,
    setTemporaryChatAddresses,
    setFileWorkspaceDirty,
    subagentConversations,
    selectedSubagentBlock,
    selectedSubagentTranscript,
    rightWorkspacePanelRef,
    bottomPanelOpenByKey,
    openFileRequest,
    setOpenFileRequest,
    forkDialogOpen,
    setForkDialogOpen,
    isDesktop,
    setWorkbenchMainRef,
    handleRightSplitResizeStart,
    rightPanelTransitionDisabled,
    chatColumnWidth,
    chatColumnMaxWidth,
    rightPanelShellWidth,
    temporaryChatAvailable,
    canBrowseFiles,
    effectiveRightPanelTabs,
    effectiveRightPanelView,
    shouldRenderRightPanel,
    fileWorkspaceTargets,
    fileWorkspaceTarget,
    initialFileWorkspaceSelection,
    startAdditionalHarnessSession,
    harnessSessionPickerOptions,
    rightHarnessWorkspaceActions,
    bottomHarnessWorkspaceActions,
    workspacePanelTarget,
    workspacePanelPrefersLocalTerminal,
    bottomPanelWorkspaceKey,
    bottomPanelContextsToRender,
    rightPanelPlanContent,
    paneIsBusy,
    hasMainBackground,
    openRightPanelTab,
    backgroundTerminals,
    openSubagentConversation,
    rightWorkspaceExtensionScope,
    updateBrowserState,
    reloadSmartAppDevelopmentPreview,
    verifySmartAppDevelopmentPreview,
    addSmartAppDevelopmentPlugin,
    selectRightPanelTab,
    closeRightPanelTab,
    selectReviewView,
    selectFilesView,
    selectFileWorkspaceTarget,
    openFileTab,
    handleFileWorkspaceSelectionChange,
    selectBrowserView,
    selectTerminalView,
    selectChatView,
    selectPlanView,
    openWorkspaceFileFromMessage,
    applyReviewPatch,
    refreshReview,
    reviewViewOptions,
    closeBottomPanelContext,
    handleTerminalTabsEmpty,
    paneTaskTitle,
    topBarLeftContent,
    showPageTopBar,
    topRightActions,
    desktopMainHeaderContent,
    paneHeaderActions,
  } = model
  const content = (
    <main
      ref={setWorkbenchMainRef}
      className={cn(
        'absolute inset-x-0 bottom-0 flex min-w-0 flex-1 flex-col overflow-hidden',
        hasMainBackground ? 'bg-background/20' : 'bg-background',
        'transition-[margin] duration-[300ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        sidebarResizing && 'transition-none',
        'top-0',
        !isDesktop &&
          presentation !== 'popout' &&
          'mt-1.5 rounded-xl border border-border/60 shadow-[0_3px_16px_rgba(0,0,0,0.04)]'
      )}
    >
      {/* Portals escape the hidden cached pane, so only the visible active pane may own the header. */}
      {desktopMainHeaderContent && paneActive && workbenchVisible && !splitMode ? (
        <WorkbenchMainHeaderPortal>{desktopMainHeaderContent}</WorkbenchMainHeaderPortal>
      ) : null}
      {paneHeaderActionsPortalId && paneVisible && workbenchVisible ? (
        <WorkbenchPaneHeaderActionsPortal targetId={paneHeaderActionsPortalId}>
          {paneHeaderActions}
        </WorkbenchPaneHeaderActionsPortal>
      ) : null}
      <>
        {!isDesktop && presentation !== 'popout' && (
          <div
            data-testid="workspace-panel-floating-actions"
            className="pointer-events-auto absolute right-8 top-1.5 z-popover flex shrink-0 items-center gap-1"
          >
            {topRightActions}
          </div>
        )}
        {showPageTopBar && (
          <DesktopTopBar
            testId="workbench-topbar"
            className={cn(
              'absolute left-0 top-0 z-chrome h-11 overflow-visible border-b border-border/50 pr-7',
              background.imagePath && background.inTopBar ? 'bg-background/20' : 'bg-background/95',
              isDesktop && sidebarCollapsed ? 'pl-[14rem]' : 'pl-4',
              'transition-none'
            )}
            style={{ maxWidth: chatColumnMaxWidth, width: chatColumnWidth }}
            left={topBarLeftContent}
            leftClassName={cn('min-w-0 gap-2', isDesktop ? 'contents' : 'max-w-[calc(100%-12rem)]')}
          />
        )}
        {paneTaskTitle}
      </>
      {paneActive && paneVisible && workbenchVisible && <LocalRuntimeNotice />}
      <div className="relative flex min-h-0 flex-1 overflow-visible">
        <div
          ref={setTurnNavigationPortalTarget}
          data-testid="message-turn-navigation-overlay"
          className={cn(
            'pointer-events-none absolute bottom-0 left-0 z-popover',
            showPageTopBar ? 'top-11' : 'top-0'
          )}
          style={{ maxWidth: chatColumnMaxWidth, width: chatColumnWidth }}
        />
        <DesktopWorkbenchConversationView model={model} />
        {rightPanelOpen && !rightPanelExpanded && (
          <div
            data-testid="right-workspace-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.resize_right_workspace_panel')}
            aria-controls="right-workspace-panel-shell"
            className={cn(
              'relative z-critical -mx-[3px] w-1.5 shrink-0 self-stretch cursor-col-resize bg-transparent after:absolute after:bottom-0 after:left-1/2 after:top-0 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 after:ease-out hover:after:bg-primary/40',
              'transition-none'
            )}
            onPointerDown={handleRightSplitResizeStart}
          />
        )}
        <div
          id="right-workspace-panel-shell"
          data-testid="right-workspace-panel-shell"
          className={cn(
            'z-popover flex h-full min-h-0 min-w-0 shrink-0 overflow-hidden',
            rightPanelExpanded ? 'absolute inset-y-0 right-0' : 'relative',
            rightPanelExpanded
              ? 'bg-background'
              : hasMainBackground
                ? 'bg-background/20'
                : 'bg-background',
            rightPanelTransitionDisabled ? 'transition-none' : RIGHT_PANEL_SHELL_TRANSITION_CLASS,
            rightPanelOpen
              ? cn(
                  'pointer-events-auto opacity-100',
                  !rightPanelExpanded && 'border-l border-border/60'
                )
              : 'pointer-events-none opacity-0'
          )}
          style={{
            minWidth:
              rightPanelOpen && !rightPanelExpanded ? RIGHT_SPLIT_PANEL_MIN_WIDTH : undefined,
            width: rightPanelShellWidth,
          }}
          aria-hidden={!rightPanelOpen}
        >
          {shouldRenderRightPanel ? (
            <RightWorkspacePanel
              ref={rightWorkspacePanelRef}
              showWorkbenchBackground={hasMainBackground && !rightPanelExpanded}
              visible={paneVisible && workbenchVisible && rightPanelOpen}
              renderTabsInAppTitlebar={!splitMode}
              expanded={rightPanelExpanded}
              activeView={effectiveRightPanelView}
              openTabs={effectiveRightPanelTabs}
              allowTemporaryChat={temporaryChatAvailable}
              currentProject={workspaceProject}
              canBrowseFiles={canBrowseFiles}
              currentRuntimeTask={currentRuntimeConversationSource}
              devices={devices}
              workspaceTarget={workspacePanelTarget}
              fileWorkspaceTarget={fileWorkspaceTarget}
              fileWorkspaceTargets={fileWorkspaceTargets}
              preferLocalTerminal={workspacePanelPrefersLocalTerminal}
              terminalContextTitle={workbenchTitle}
              workspaceActions={rightHarnessWorkspaceActions}
              harnessSessions={localHarnessSessions}
              workspaceSessionApi={workspaceSessionApi}
              workspaceFileApi={workspaceFileApi}
              openFileRequest={openFileRequest}
              initialFileSelection={initialFileWorkspaceSelection}
              fileTabs={fileTabs}
              onOpenFileTab={openFileTab}
              workspaceTargetError={
                openFileRequest?.target || openFileRequest?.attachment ? null : workspaceTargetError
              }
              review={reviewState}
              planContent={rightPanelPlanContent}
              backgroundTerminals={backgroundTerminals}
              subagentPanel={
                selectedSubagentBlock ? (
                  <SubagentConversationPanel
                    block={selectedSubagentBlock}
                    onBack={() => setSelectedSubagentConversationId(null)}
                    onOpenSubagent={openSubagentConversation}
                    onOpenWorkspaceFile={openWorkspaceFileFromMessage}
                    transcriptMessages={selectedSubagentTranscript?.messages}
                    transcriptLoading={selectedSubagentTranscript?.loading}
                    transcriptError={selectedSubagentTranscript?.error}
                  />
                ) : (
                  <SubagentOverviewPanel
                    blocks={subagentConversations}
                    onSelect={openSubagentConversation}
                  />
                )
              }
              extensionTabs={rightPanelExtensionTabs}
              extensionScope={rightWorkspaceExtensionScope}
              workItemPanel={
                workItemContextAvailable &&
                currentProjectSpaceRuntimeTask &&
                boundCloudProject &&
                boundCloudItem &&
                boundProjectSpaceApi ? (
                  <WorkItemContextPanel
                    key={`${boundCloudProject.id}:${boundCloudItem.id}:${boundCloudItem.version}:${currentProjectSpaceRuntimeTask.deviceId}:${currentProjectSpaceRuntimeTask.taskId}`}
                    api={boundProjectSpaceApi}
                    services={services}
                    project={boundCloudProject}
                    item={boundCloudItem}
                    currentTask={currentProjectSpaceRuntimeTask}
                    currentUserId={state.user?.id}
                    localProjects={state.projects}
                    deviceNamesById={getWorkbenchDeviceNamesById(state.devices)}
                    onOpenBoard={openBoundProjectSpaceTask}
                    onOpenTask={openRuntimeTask}
                  />
                ) : null
              }
              browserStates={browserStates}
              browserTransferSourceLabels={browserTransferSourceLabels}
              onBrowserStateChange={updateBrowserState}
              onReloadSmartAppDevelopmentPreview={reloadSmartAppDevelopmentPreview}
              onAddSmartAppDevelopmentPlugin={addSmartAppDevelopmentPlugin}
              onVerifySmartAppDevelopmentPreview={verifySmartAppDevelopmentPreview}
              codeCommentCount={paneSession.codeCommentContexts.length}
              codeCommentContexts={paneSession.codeCommentContexts}
              browserAnnotationCommand={paneSession.browserAnnotationCommand}
              reviewViewOptions={reviewViewOptions}
              canOpenReview={Boolean(loadEnvironmentDiff && workspaceTarget)}
              onAddCodeComment={paneSession.addCodeComment}
              onReplaceBrowserCodeComments={paneSession.replaceBrowserCodeComments}
              onRemoveBrowserCodeComments={paneSession.removeBrowserCodeComments}
              onFileDirtyChange={setFileWorkspaceDirty}
              onFileSelectionChange={handleFileWorkspaceSelectionChange}
              onSelectFileWorkspaceTarget={selectFileWorkspaceTarget}
              onSelectReview={selectReviewView}
              onSelectTerminal={selectTerminalView}
              onSelectBrowser={selectBrowserView}
              onSelectFiles={selectFilesView}
              onSelectChat={selectChatView}
              onSelectPlan={selectPlanView}
              onSelectTab={selectRightPanelTab}
              onCloseTab={closeRightPanelTab}
              onHarnessSessionExit={onLocalHarnessSessionExit}
              onRefreshReview={reviewState.reloadDiff ? refreshReview : undefined}
              onOpenWorkspaceFile={openWorkspaceFileFromMessage}
              onOpenReviewSourceFile={(path, lineStart, lineEnd) =>
                void openWorkspaceFileFromMessage(path, { lineStart, lineEnd })
              }
              onApplyReviewPatch={
                reviewState.reviewMode === 'unstaged' || reviewState.reviewMode === 'staged'
                  ? applyReviewPatch
                  : undefined
              }
              onRestoreConversation={() => setRightPanelExpanded(false)}
              getChatInitialInput={tab => temporaryChatInitialInputsRef.current.get(tab)}
              getChatInitialAddress={tab => temporaryChatAddresses[tab]}
              onChatAddressChange={(tab, address) => {
                setTemporaryChatAddresses(current => {
                  if (!address) {
                    if (!current[tab]) return current
                    const next = { ...current }
                    delete next[tab]
                    return next
                  }
                  if (
                    current[tab]?.taskId === address.taskId &&
                    current[tab]?.deviceId === address.deviceId
                  ) {
                    return current
                  }
                  return { ...current, [tab]: address }
                })
              }}
            />
          ) : null}
        </div>
      </div>
      {bottomPanelContextsToRender.map(context => {
        const active = context.key === bottomPanelWorkspaceKey
        return (
          <MemoizedBottomWorkspacePanel
            key={context.key}
            panelKey={context.key}
            open={active && (bottomPanelOpenByKey[context.key] ?? false)}
            active={active}
            paneVisible={paneVisible && workbenchVisible}
            context={context}
            workspaceSessionApi={workspaceSessionApi}
            showWorkbenchBackground={hasMainBackground}
            workspaceActions={bottomHarnessWorkspaceActions}
            onRequestClose={closeBottomPanelContext}
            onTerminalTabsEmpty={handleTerminalTabsEmpty}
          />
        )
      })}
      <>
        <HarnessSessionPickerDialog
          open={harnessSessionPickerTarget !== null}
          options={harnessSessionPickerOptions}
          onClose={() => setHarnessSessionPickerTarget(null)}
          onSelect={(harnessId, model) =>
            startAdditionalHarnessSession(harnessId, harnessSessionPickerTarget ?? 'main', model)
          }
        />
        <TaskForkDialog
          key={forkDialogOpen ? `fork-open-${currentRuntimeTask?.taskId ?? 'none'}` : 'fork-closed'}
          open={forkDialogOpen}
          source={currentRuntimeTask}
          runtimeWork={runtimeWork}
          currentProject={currentProject}
          devices={devices}
          requiresStop={paneIsBusy}
          onOpenChange={setForkDialogOpen}
          onStopCurrentResponse={() => paneSession.pauseCurrentResponse()}
          onPrepareDeviceWorkspace={prepareDeviceWorkspace}
          onDeleteDeviceWorkspace={deleteDeviceWorkspace}
          onGetDeviceHomeDirectory={getDeviceHomeDirectory}
          onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
          onListDeviceDirectories={listDeviceDirectories}
          onCreateDeviceDirectory={createDeviceDirectory}
          onFork={async target => {
            await forkCurrentRuntimeTask(target, {
              source: currentRuntimeTask ?? undefined,
            })
          }}
        />
        <TaskSupervisorControl
          open={supervisorDialogOpen && !issueExecutionReadOnly}
          supervisor={supervisor}
          initialConfig={pendingSupervisorConfig}
          defaultModelSelection={appPreferences?.preferences.supervisorModelSelection ?? null}
          defaultIntervalSeconds={appPreferences?.preferences.supervisorIntervalSeconds ?? 30}
          defaultInstructions={appPreferences?.preferences.supervisorPrinciples ?? ''}
          models={projectChat.models}
          onOpenChange={open =>
            setSupervisorDialogTaskKey(
              open && !issueExecutionReadOnly ? supervisorDialogScopeKey : null
            )
          }
          onSet={setTaskSupervisor}
          onClear={clearTaskSupervisor}
          onRunNow={currentRuntimeTask ? runTaskSupervisorNow : undefined}
        />
        <TransientNotice
          message={additionalHarnessError}
          tone="error"
          onClear={() => setAdditionalHarnessError(null)}
        />
        <TransientNotice
          message={fileOpenError}
          tone="error"
          onClear={() => setFileOpenError(null)}
        />
        <TransientNotice message={todoBindingError} tone="error" onClear={clearTodoBindingError} />
        <TransientNotice message={cloudActionNotice} onClear={clearCloudActionNotice} />
        <TaskBoardAssociationDialog
          key={
            taskBoardAssociation
              ? `board-association-${taskBoardAssociation.project.project_store}:${taskBoardAssociation.project.id}`
              : 'board-association-closed'
          }
          project={taskBoardAssociation?.project ?? null}
          currentProject={boundCloudProject}
          items={taskBoardAssociation?.items ?? []}
          loading={taskBoardAssociation?.loading ?? false}
          pending={taskBoardAssociation?.pending ?? false}
          onClose={closeTaskBoardAssociation}
          onCreate={associateRuntimeTaskWithNewItem}
          onSelect={associateRuntimeTaskWithExistingItem}
        />
        {deliveryDialogOpen && activeDeliveryItem && currentRuntimeTask && boundProjectSpaceApi && (
          <DeliveryDialog
            item={activeDeliveryItem}
            runtimeTask={currentRuntimeTask}
            runtimeTaskTitle={runtimeTaskTitle}
            messages={paneSession.messages}
            deliveryApi={boundProjectSpaceApi}
            onCancel={closeDeliveryDialog}
            onDelivered={finishDelivery}
          />
        )}
      </>
    </main>
  )
  return (
    <AttachmentPreviewContext.Provider
      value={source => {
        setOpenFileRequest(current => ({
          id: (current?.id ?? 0) + 1,
          path: source.filename,
          target: current?.target,
          attachment: source,
        }))
        openRightPanelTab('files')
      }}
    >
      <ImageEditProvider actions={imageEditSubmission}>{content}</ImageEditProvider>
      {model.panelActionDialogs}
    </AttachmentPreviewContext.Provider>
  )
}
