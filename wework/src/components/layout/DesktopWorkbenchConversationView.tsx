import { ConversationEventContext } from '@/components/chat/composer/ConversationEventContext'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { RequestUserInputComposer } from '@/components/chat/RequestUserInputComposer'
import {
  isImplementationPlanConfirmationResponse,
  isImplementationPlanRequestUserInput,
  requestUserInputPayloadKey,
} from '@/components/chat/requestUserInputMessages'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { PluginWorkspaceConversationResult } from '@/components/plugins/PluginWorkspaceConversationResult'
import { updateAppPreferences } from '@/desktop/appPreferences'
import { getErrorMessage } from '@/lib/error-message'
import { localHarnessLabel } from '@/lib/local-harness'
import { cn } from '@/lib/utils'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { ChevronRight, Loader2, MessageCircle } from 'lucide-react'
import { BufferedChatInput } from './BufferedChatInput'
import { CentralHarnessTerminal } from './CentralHarnessTerminal'
import { ConversationDeviceOfflineBanner } from './ConversationDeviceOfflineBanner'
import { DESKTOP_MESSAGE_LIST_CLASS, DESKTOP_MESSAGE_LIST_WIDTH_CLASS } from './desktopChatLayout'
import { DesktopEmptyTaskLauncher } from './DesktopEmptyTaskLauncher'
import {
  DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS,
  DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS,
  DESKTOP_STICKY_COMPOSER_FOOTER_CLASS,
  DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
  runtimeTaskForkModelOptions,
} from './desktopWorkbenchMainHelpers'
import type { DesktopWorkbenchPaneRenderModel } from './desktopWorkbenchPaneChrome'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'
import {
  pendingRequestUserInputPayloads,
  pendingRequestUserInputResponses,
} from './requestUserInputOverlay'
import { TaskDetailScrollArea } from './TaskDetailScrollArea'
import { SupervisorSuggestionCards } from './TaskSupervisorControl'
import { WorkbenchHarnessModelSelector } from './WorkbenchHarnessModelSelector'
import { WorkbenchHarnessSelector } from './WorkbenchHarnessSelector'
import { requestOpenCloudDeviceSettings } from './workbenchShellEvents'
import { WorktreeCreationStatus } from './WorktreeCreationStatus'

export function DesktopWorkbenchConversationView({
  model,
}: {
  model: DesktopWorkbenchPaneRenderModel
}) {
  const {
    workbenchVisible,
    presentation,
    activeLocalHarnessSession,
    onLocalHarnessSessionClose,
    onLocalHarnessSessionExit,
    paneActive,
    showComposerProjectMenuAction,
    alwaysShowComposerToolbar,
    paneVisible,
    experimentalFeaturesEnabled,
    workspaceFileApi,
    upgradingDevices,
    upgradeDevice,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
    forkCurrentRuntimeTask,
    services,
    t,
    currentRuntimeTask,
    currentProject,
    paneModelChat,
    turnNavigationPortalTarget,
    paneSession,
    setNewChatRuntime,
    setLocalHarnessModelKeys,
    localHarnessPreferences,
    enabledLocalHarnesses,
    localHarnesses,
    localHarnessesLoading,
    localHarnessDetectionFailed,
    centralHarnessStarting,
    centralHarnessError,
    setCentralHarnessError,
    pendingSupervisorConfig,
    currentRuntimeConversationSource,
    eventSubscriptionScope,
    connectionEventSubscriptions,
    cancelCurrentEventSubscription,
    eventCancellationUnsupported,
    activeDeviceUnavailable,
    deviceApi,
    runtimeTaskSummary,
    cloudProjectMentionCandidates,
    handleSelectCloudProject,
    openBoundProjectSpaceTask,
    visibleCloudMentionCandidates,
    issueExecutionReadOnly,
    mcpAppConversationServices,
    supervisor,
    defaultEmbeddedBrowserLabel,
    supervisorFeatureAvailable,
    connectorAuthCard,
    submitPaneInput,
    resolveTaskSupervisorSuggestion,
    isBootstrapping,
    devices,
    runtimeTaskWorkspacePath,
    pendingModelRetryRef,
    previousTurnReviewRef,
    rightPanelExpanded,
    setRightPanelExpanded,
    conversationSelectionInsertion,
    setHasPreviousTurnReview,
    workbenchScrollRef,
    workbenchScrollbarRef,
    conversationSurfaceRef,
    setEnvironmentInfoPanelRef,
    chatColumnWidth,
    chatColumnMaxWidth,
    environmentInfoDocked,
    environmentInfoPanelExpanded,
    openSupervisorDialog,
    temporaryChatExpanded,
    chatContentResizing,
    activeDeviceId,
    composerWorkspaceTarget,
    remoteImageTarget,
    selectedHarnessPreference,
    harnessModelOptions,
    selectedHarnessModel,
    activeNewChatRuntime,
    activeHarnessDisplayError,
    submitWorkbenchInput,
    paneMessages,
    pendingRequestUserInput,
    paneQueuedMessages,
    paneGuidanceMessages,
    paneIsBusy,
    setModelSelectorOpenSignal,
    setProjectMenuOpenSignal,
    setProjectMenuAnchorElement,
    hasConversation,
    isCreatingWorktree,
    hasMainBackground,
    activeDevice,
    currentRuntimeUsesCodex,
    canEditLastUserMessage,
    composerSupportsGoal,
    showConversationDeviceBanner,
    noStandaloneCompatibleDevice,
    composerDisabled,
    inlineComposerDisabledReason,
    projectChatWithModelSelectorSignal,
    branchNameProjectWork,
    emptyProjectWork,
    popoutComposerPlaceholder,
    selectTaskSuggestion,
    openSubagentConversation,
    projectSpaceContext,
    addSelectionToConversation,
    askSelectionInSidebar,
    focusComposerFromConversationClick,
    openAssistantPlan,
    openReviewFromDiffLoader,
    openWorkspaceFileFromMessage,
    openLocalSkillFile,
    fileChangesDiffPreviewDisabledSubtaskId,
    pauseCurrentResponse,
    compactCurrentContext,
    setCurrentGoal,
    pauseCurrentGoal,
    resumeCurrentGoal,
    clearCurrentGoal,
    showPageTopBar,
  } = model
  return (
    <TaskDetailScrollArea
      viewportRef={workbenchScrollRef}
      scrollbarRef={workbenchScrollbarRef}
      hasConversation={hasConversation}
      showPageTopBar={showPageTopBar}
      defaultEmbeddedBrowserLabel={defaultEmbeddedBrowserLabel}
      frameClassName={cn('relative flex h-full min-w-0 flex-none', 'transition-none')}
      frameStyle={{ maxWidth: chatColumnMaxWidth, width: chatColumnWidth }}
      overlay={
        <aside
          data-testid="environment-info-panel-container"
          data-docked={environmentInfoDocked}
          className={cn(
            'absolute inset-y-0 right-0 z-popover flex w-0 flex-col overflow-hidden',
            environmentInfoPanelExpanded && 'w-[320px] overflow-visible',
            showPageTopBar && 'pt-11',
            'transition-none'
          )}
        >
          <div ref={setEnvironmentInfoPanelRef} className="shrink-0" />
        </aside>
      }
    >
      <>
        <div className="grid w-full flex-1 grid-cols-[minmax(0,1fr)_auto]">
          {isBootstrapping ? (
            <div className="flex min-w-0 flex-1" data-testid="desktop-workbench-loading" />
          ) : activeLocalHarnessSession ? (
            <div className="relative flex min-h-0 min-w-0">
              {activeLocalHarnessSession.active ? (
                <CentralHarnessTerminal
                  sessionId={activeLocalHarnessSession.sessionId}
                  title={activeLocalHarnessSession.title}
                  cwd={activeLocalHarnessSession.cwd}
                  active={paneActive && workbenchVisible}
                  showHeader={false}
                  onClose={
                    activeLocalHarnessSession.isPrimary
                      ? undefined
                      : () => {
                          void onLocalHarnessSessionClose(activeLocalHarnessSession.sessionId)
                        }
                  }
                  onExit={() => onLocalHarnessSessionExit(activeLocalHarnessSession.sessionId)}
                />
              ) : (
                <div
                  data-testid="local-harness-session-resuming"
                  className={cn(
                    'flex min-h-0 min-w-0 flex-1 items-center justify-center text-sm',
                    activeHarnessDisplayError ? 'text-destructive' : 'text-text-secondary'
                  )}
                >
                  {activeHarnessDisplayError ? (
                    activeHarnessDisplayError
                  ) : (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      {t('workbench.harness_resuming', {
                        name: localHarnessLabel(activeLocalHarnessSession.harnessId),
                        defaultValue: `正在恢复 ${localHarnessLabel(activeLocalHarnessSession.harnessId)} 会话…`,
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : hasConversation ? (
            <div
              ref={conversationSurfaceRef}
              className="relative flex min-w-0 flex-col"
              onClick={focusComposerFromConversationClick}
            >
              <ScrollableMessageArea
                mcpApp={mcpAppConversationServices}
                searchActive={paneActive && paneVisible && workbenchVisible}
                imageTarget={remoteImageTarget}
                messages={paneMessages}
                turns={paneSession.turns}
                loading={paneSession.transcriptLoading}
                transcriptError={paneSession.transcriptError}
                onRetryTranscript={paneSession.reloadRuntimeTranscript}
                isWaitingForAssistant={
                  !isCreatingWorktree && paneSession.status.isWaitingForAssistantIndicator
                }
                hasMoreBefore={paneSession.transcriptHasMoreBefore}
                beforeCursor={paneSession.transcriptBeforeCursor}
                onSearchTranscript={paneSession.searchTranscript}
                onEnsureSearchMatch={paneSession.ensureSearchMatch}
                searchPage={paneSession.searchPage}
                onLoadSearchContext={paneSession.loadSearchContext}
                onReleaseSearchPage={paneSession.releaseSearchPage}
                loadingMoreBefore={paneSession.transcriptLoadingMoreBefore}
                turnNavigation={paneSession.turnNavigation}
                loadedTranscriptRanges={paneSession.loadedTranscriptRanges}
                autoScrollSuspended={!paneVisible || !workbenchVisible}
                onLoadMoreBefore={paneSession.loadMoreTranscriptBefore}
                onLoadTurnNavigationItem={paneSession.loadTranscriptTurnNavigationItem}
                onLoadTranscriptGap={paneSession.loadTranscriptGap}
                conversationKey={
                  currentRuntimeTask
                    ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
                    : null
                }
                className="flex flex-col"
                scrollTestId="desktop-chat-scroll"
                externalScrollRef={workbenchScrollRef}
                externalScrollInteractionRef={workbenchScrollbarRef}
                turnNavigationPortalTarget={turnNavigationPortalTarget}
                scrollerClassName="h-auto flex-1 overflow-visible"
                contentClassName={rightPanelExpanded ? 'invisible' : undefined}
                messageListClassName={cn(
                  DESKTOP_MESSAGE_LIST_CLASS,
                  chatContentResizing && 'transition-none'
                )}
                contentFooter={
                  isCreatingWorktree ? (
                    <WorktreeCreationStatus className="py-8" />
                  ) : issueExecutionReadOnly ? null : (
                    <PluginWorkspaceConversationResult
                      taskId={currentRuntimeTask?.taskId}
                      workspacePath={currentRuntimeTask?.workspacePath || runtimeTaskWorkspacePath}
                      messages={paneMessages}
                      waiting={paneSession.status.isWaitingForAssistantIndicator}
                      onOpenFile={path => void openWorkspaceFileFromMessage(path)}
                      onSendAction={(message, additionalContext) =>
                        paneSession.send(message, { additionalContext })
                      }
                    />
                  )
                }
                contentFooterClassName={DESKTOP_MESSAGE_LIST_WIDTH_CLASS}
                stickyFooterClassName={cn(
                  DESKTOP_STICKY_COMPOSER_FOOTER_CLASS,
                  hasMainBackground
                    ? 'from-transparent via-transparent'
                    : 'from-background via-background',
                  chatContentResizing && 'transition-none',
                  rightPanelExpanded && 'z-critical'
                )}
                stickyFooter={
                  (temporaryChatExpanded && !pendingRequestUserInput) ||
                  isCreatingWorktree ? null : (
                    <>
                      <div
                        className={cn(
                          DESKTOP_STICKY_COMPOSER_BACKDROP_CLASS,
                          hasMainBackground
                            ? 'from-transparent via-transparent'
                            : 'from-background via-background'
                        )}
                        data-testid="desktop-floating-composer-backdrop"
                      />
                      <div
                        className={cn(
                          DESKTOP_STICKY_COMPOSER_LAYER_CLASS,
                          chatContentResizing && 'transition-none',
                          rightPanelExpanded && 'z-critical'
                        )}
                        data-testid="desktop-floating-composer-layer"
                      >
                        <div
                          className="pointer-events-auto"
                          data-testid="desktop-floating-composer-card"
                        >
                          {rightPanelExpanded && (
                            <ControlButton
                              variant="unstyled"
                              type="button"
                              data-testid="restore-conversation-from-expanded-workspace-button"
                              className="mb-1 flex h-8 w-full items-center justify-between rounded-xl border border-border/45 bg-background/95 px-4 text-xs text-text-secondary shadow-sm hover:bg-muted hover:text-text-primary"
                              onClick={() => setRightPanelExpanded(false)}
                            >
                              <span>{t('workbench.latest_conversation_turn')}</span>
                              <ChevronRight className="h-4 w-4" aria-hidden="true" />
                            </ControlButton>
                          )}
                          {connectorAuthCard}
                          {issueExecutionReadOnly ? (
                            <div
                              data-testid="project-execution-reply-in-issue"
                              className="flex items-center gap-3 rounded-2xl border border-border/50 bg-background/95 px-4 py-3 shadow-sm"
                            >
                              <MessageCircle
                                className="h-4 w-4 shrink-0 text-text-muted"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 text-sm text-text-secondary">
                                {t(
                                  'workbench.project_execution_reply_in_issue',
                                  '此执行属于 Issue，请在 Issue 中追问或补充要求'
                                )}
                              </span>
                              <ControlButton
                                variant="unstyled"
                                type="button"
                                data-testid="project-execution-open-issue"
                                onClick={openBoundProjectSpaceTask}
                                className="flex h-8 shrink-0 items-center rounded-lg bg-foreground px-3 text-sm font-medium text-background hover:opacity-90"
                              >
                                {t('workbench.back_to_work_item', '返回 Issue')}
                              </ControlButton>
                            </div>
                          ) : !rightPanelExpanded || pendingRequestUserInput ? (
                            <>
                              {showConversationDeviceBanner ? (
                                <ConversationDeviceOfflineBanner
                                  device={activeDevice}
                                  deviceId={activeDeviceId}
                                  className="mb-2"
                                />
                              ) : (
                                <DeviceStatusPrompt
                                  devices={devices}
                                  upgradingDevices={upgradingDevices}
                                  onUpgradeDevice={upgradeDevice}
                                  onOpenCloudDeviceSettings={requestOpenCloudDeviceSettings}
                                  activeDeviceId={activeDeviceId}
                                  requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                                  hideAvailableUpdates
                                  className="mb-2"
                                />
                              )}
                              <RequestUserInputComposer
                                payload={pendingRequestUserInput}
                                source={currentRuntimeTask}
                                questionContext={
                                  <ConversationEventContext
                                    integrated
                                    goal={paneSession.goal}
                                    goalDraftActive={paneSession.goalDraftActive}
                                    continuing={paneSession.goalContinuing}
                                    executionStatus={paneSession.goalExecutionStatus}
                                    eventSubscriptionScope={eventSubscriptionScope}
                                    onCancelEventSubscription={cancelCurrentEventSubscription}
                                    eventCancellationUnsupported={eventCancellationUnsupported}
                                    eventCancellationUnavailable={
                                      activeDeviceUnavailable || !deviceApi
                                    }
                                    subscriptions={connectionEventSubscriptions}
                                    interactionStatus={runtimeTaskSummary?.interactionStatus}
                                    onEditGoal={paneSession.editCurrentGoal}
                                    onPauseGoal={pauseCurrentGoal}
                                    onResumeGoal={resumeCurrentGoal}
                                    onClearGoal={clearCurrentGoal}
                                  />
                                }
                                renderQuestion={onCollapse =>
                                  pendingRequestUserInput ? (
                                    <RequestUserInputCard
                                      key={
                                        requestUserInputPayloadKey(pendingRequestUserInput) ??
                                        'implementation-plan'
                                      }
                                      payload={pendingRequestUserInput}
                                      source={currentRuntimeTask}
                                      messages={paneMessages}
                                      onCollapse={onCollapse}
                                      onSubmit={response => {
                                        const isImplementationPlanRequest =
                                          isImplementationPlanRequestUserInput(
                                            pendingRequestUserInput
                                          )
                                        const shouldImplementPlan =
                                          isImplementationPlanRequest &&
                                          isImplementationPlanConfirmationResponse(response)
                                        return paneSession.sendRequestUserInputResponse(response, {
                                          requestUserInputResponses:
                                            pendingRequestUserInputResponses(
                                              response,
                                              paneMessages,
                                              paneSession.answeredRequestUserInputIds
                                            ),
                                          appendUserMessage: isImplementationPlanRequest,
                                          forceDefaultCollaborationMode: shouldImplementPlan,
                                        })
                                      }}
                                      onIgnore={() =>
                                        paneSession.ignoreRequestUserInput(
                                          pendingRequestUserInputPayloads(
                                            paneMessages,
                                            paneSession.answeredRequestUserInputIds
                                          )
                                        )
                                      }
                                    />
                                  ) : null
                                }
                              >
                                <>
                                  {supervisor && (
                                    <SupervisorSuggestionCards
                                      suggestions={supervisor.suggestions}
                                      onAccept={suggestion =>
                                        resolveTaskSupervisorSuggestion(suggestion, 'accepted')
                                      }
                                      onDismiss={suggestion =>
                                        resolveTaskSupervisorSuggestion(suggestion, 'dismissed')
                                      }
                                    />
                                  )}
                                  <BufferedChatInput
                                    alwaysShowComposerToolbar={alwaysShowComposerToolbar}
                                    autoFocus
                                    insertion={conversationSelectionInsertion}
                                    value={paneSession.input}
                                    replaceDraftKey={paneSession.replaceDraftKey}
                                    onChange={paneSession.setInput}
                                    onDraftEdit={paneSession.onDraftEdit}
                                    onSubmit={submitPaneInput}
                                    disabled={composerDisabled || !paneVisible || !workbenchVisible}
                                    showPluginPicker={!hasConversation}
                                    submitDisabled={paneSession.status.isSubmitting}
                                    error={paneSession.error}
                                    disabledReason={inlineComposerDisabledReason}
                                    placeholder={t(
                                      'workbench.follow_up_placeholder',
                                      '要求后续变更'
                                    )}
                                    variant="desktop"
                                    projectChat={projectChatWithModelSelectorSignal}
                                    projectWork={branchNameProjectWork}
                                    showProjectWorkBar={false}
                                    queuedMessages={paneQueuedMessages}
                                    guidanceMessages={paneGuidanceMessages}
                                    codeComments={paneSession.codeCommentContexts}
                                    cloudMentionCandidates={visibleCloudMentionCandidates}
                                    cloudProjectCandidates={cloudProjectMentionCandidates}
                                    cloudSpaceEnabled={
                                      experimentalFeaturesEnabled && Boolean(services?.deliveryApi)
                                    }
                                    onSelectCloudProject={handleSelectCloudProject}
                                    contextHeader={
                                      projectSpaceContext && (
                                        <div
                                          className={cn(
                                            'flex',
                                            paneSession.transcriptLoading && 'invisible'
                                          )}
                                          inert={paneSession.transcriptLoading}
                                        >
                                          {projectSpaceContext}
                                        </div>
                                      )
                                    }
                                    isStreaming={paneIsBusy}
                                    onPause={pauseCurrentResponse}
                                    onCompactContext={
                                      currentRuntimeUsesCodex ||
                                      currentRuntimeTask?.runtime === 'claude_code'
                                        ? compactCurrentContext
                                        : undefined
                                    }
                                    goal={paneSession.goal}
                                    goalContinuing={paneSession.goalContinuing}
                                    goalExecutionStatus={paneSession.goalExecutionStatus}
                                    eventSubscriptionScope={eventSubscriptionScope}
                                    onCancelEventSubscription={cancelCurrentEventSubscription}
                                    eventCancellationUnsupported={eventCancellationUnsupported}
                                    eventCancellationUnavailable={
                                      activeDeviceUnavailable || !deviceApi
                                    }
                                    eventSubscriptions={connectionEventSubscriptions}
                                    interactionStatus={runtimeTaskSummary?.interactionStatus}
                                    taskPlan={paneSession.taskPlan}
                                    goalDraftActive={paneSession.goalDraftActive}
                                    onSetGoal={composerSupportsGoal ? setCurrentGoal : undefined}
                                    onConfigureSupervisor={
                                      supervisorFeatureAvailable ? openSupervisorDialog : undefined
                                    }
                                    supervisorEnabled={Boolean(
                                      supervisor || pendingSupervisorConfig
                                    )}
                                    supervisorPending={Boolean(
                                      !currentRuntimeTask && pendingSupervisorConfig
                                    )}
                                    onCancelGoalDraft={paneSession.cancelGoalDraft}
                                    onEditGoal={paneSession.editCurrentGoal}
                                    onPauseGoal={pauseCurrentGoal}
                                    onResumeGoal={resumeCurrentGoal}
                                    onClearGoal={clearCurrentGoal}
                                    onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                                    onForceStartQueuedMessage={paneSession.forceStartQueuedMessage}
                                    onReorderQueuedMessages={paneSession.reorderQueuedMessages}
                                    queuePaused={paneSession.queuedMessagesPaused}
                                    onResumeQueue={paneSession.resumeQueuedMessages}
                                    onResumeQueueWithInput={
                                      paneSession.resumeQueuedMessagesWithInput
                                    }
                                    onClearQueue={paneSession.clearQueuedMessages}
                                    onSendQueuedAsGuidance={
                                      currentRuntimeUsesCodex
                                        ? paneSession.sendQueuedAsGuidance
                                        : undefined
                                    }
                                    onInterruptAndSendQueuedMessage={
                                      paneSession.interruptAndSendQueued
                                    }
                                    onEditQueuedMessage={paneSession.editQueuedMessage}
                                    onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                                    onClearCodeComments={paneSession.clearCodeComments}
                                    onOpenSkillFile={openLocalSkillFile}
                                    workspaceTarget={composerWorkspaceTarget}
                                    workspaceFileApi={workspaceFileApi}
                                  />
                                </>
                              </RequestUserInputComposer>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </>
                  )
                }
                scrollButtonClassName={DESKTOP_SCROLL_TO_BOTTOM_BUTTON_CLASS}
                devices={devices}
                onRetryFailedMessage={
                  issueExecutionReadOnly
                    ? undefined
                    : message => {
                        void paneSession.retryFailedMessage(message)
                      }
                }
                onSwitchModelForFailedMessage={
                  issueExecutionReadOnly
                    ? undefined
                    : message => {
                        pendingModelRetryRef.current = message
                        setModelSelectorOpenSignal(signal => signal + 1)
                      }
                }
                onLoadFileChangesDiff={(subtaskId, fileChanges) =>
                  loadTurnFileChangesDiff(subtaskId, paneMessages, fileChanges, currentRuntimeTask)
                }
                onRevertFileChanges={
                  issueExecutionReadOnly
                    ? undefined
                    : (subtaskId, fileChanges) =>
                        revertTurnFileChanges(
                          subtaskId,
                          paneMessages,
                          fileChanges,
                          currentRuntimeTask
                        )
                }
                onOpenFileChangesReview={({
                  subtaskId,
                  loadDiff,
                  reviewTitle,
                  defaultFileTreeVisible,
                  focusFilePath,
                }) => {
                  previousTurnReviewRef.current = {
                    loadDiff,
                    defaultFileTreeVisible,
                    sourceSubtaskId: subtaskId,
                  }
                  setHasPreviousTurnReview(true)
                  void openReviewFromDiffLoader(loadDiff, {
                    reviewTitle,
                    reviewMode: 'previous-turn',
                    defaultFileTreeVisible,
                    focusFilePath,
                    sourceSubtaskId: subtaskId,
                  })
                }}
                fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
                onOpenWorkspaceFile={openWorkspaceFileFromMessage}
                onOpenLocalSkillFile={openLocalSkillFile}
                onRequestUserInputSubmit={
                  issueExecutionReadOnly ? undefined : paneSession.sendRequestUserInputResponse
                }
                onRequestUserInputIgnore={
                  issueExecutionReadOnly ? undefined : paneSession.ignoreRequestUserInput
                }
                onOpenAssistantPlan={openAssistantPlan}
                onEditLastUserMessage={
                  issueExecutionReadOnly ? undefined : paneSession.editLastUserMessage
                }
                canEditLastUserMessage={issueExecutionReadOnly ? false : canEditLastUserMessage}
                onForkMessage={
                  !issueExecutionReadOnly &&
                  currentRuntimeUsesCodex &&
                  currentRuntimeTask &&
                  (currentRuntimeTask.workspacePath || runtimeTaskWorkspacePath)
                    ? async message => {
                        const workspacePath =
                          currentRuntimeTask?.workspacePath || runtimeTaskWorkspacePath
                        if (!currentRuntimeTask || !message.turnId || !workspacePath) return
                        paneSession.clearError()
                        try {
                          await forkCurrentRuntimeTask(
                            {
                              deviceId: currentRuntimeTask.deviceId,
                              workspacePath,
                            },
                            {
                              source: currentRuntimeConversationSource ?? currentRuntimeTask,
                              lastTurnId: message.turnId,
                              ...runtimeTaskForkModelOptions(paneModelChat),
                            }
                          )
                        } catch (error) {
                          paneSession.setError(
                            getErrorMessage(error, t('workbench.task_fork_failed'))
                          )
                        }
                      }
                    : undefined
                }
                hideRequestUserInputBlocks={Boolean(pendingRequestUserInput)}
                hiddenRequestUserInputIds={paneSession.answeredRequestUserInputIds}
                onAddSelectionToConversation={addSelectionToConversation}
                onAskSelectionInSidebar={askSelectionInSidebar}
                onOpenSubagent={openSubagentConversation}
              />
            </div>
          ) : rightPanelExpanded ? null : (
            <DesktopEmptyTaskLauncher
              searchActive={paneActive && paneVisible && workbenchVisible}
              connectorAuthCard={connectorAuthCard}
              compact={presentation === 'popout'}
              projectName={currentProject?.name}
              showWorkbenchBackground={hasMainBackground}
              onOpenProjectSelector={anchorElement => {
                setProjectMenuAnchorElement(anchorElement)
                setProjectMenuOpenSignal(signal => signal + 1)
              }}
              onSelectSuggestion={selectTaskSuggestion}
              composer={
                rightPanelExpanded ? null : (
                  <>
                    <DeviceStatusPrompt
                      devices={devices}
                      upgradingDevices={upgradingDevices}
                      onUpgradeDevice={upgradeDevice}
                      onOpenCloudDeviceSettings={requestOpenCloudDeviceSettings}
                      activeDeviceId={activeDeviceId}
                      requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                      hideAvailableUpdates
                      className="mb-3"
                    />
                    <BufferedChatInput
                      alwaysShowComposerToolbar={alwaysShowComposerToolbar}
                      showProjectWorkBar={presentation !== 'popout'}
                      autoFocus
                      value={paneSession.input}
                      replaceDraftKey={paneSession.replaceDraftKey}
                      onChange={paneSession.setInput}
                      onDraftEdit={() => {
                        paneSession.onDraftEdit()
                        setCentralHarnessError(null)
                      }}
                      onSubmit={submitWorkbenchInput}
                      disabled={
                        centralHarnessStarting ||
                        ((activeNewChatRuntime === 'codex' ||
                          activeNewChatRuntime === 'claude_code') &&
                          composerDisabled) ||
                        !paneVisible ||
                        !workbenchVisible
                      }
                      submitDisabled={
                        centralHarnessStarting ||
                        ((activeNewChatRuntime === 'codex' ||
                          activeNewChatRuntime === 'claude_code') &&
                          paneSession.status.isSubmitting)
                      }
                      error={centralHarnessError ?? paneSession.error}
                      disabledReason={
                        activeNewChatRuntime === 'codex' || activeNewChatRuntime === 'claude_code'
                          ? inlineComposerDisabledReason
                          : undefined
                      }
                      placeholder={
                        showComposerProjectMenuAction
                          ? 'values' in popoutComposerPlaceholder
                            ? t(popoutComposerPlaceholder.key, popoutComposerPlaceholder.values)
                            : t(popoutComposerPlaceholder.key)
                          : t('workbench.input_placeholder', '随心输入')
                      }
                      variant="desktop"
                      projectChat={projectChatWithModelSelectorSignal}
                      projectWork={emptyProjectWork}
                      projectWorkBarMiddleContext={projectSpaceContext}
                      projectWorkBarTrailingContext={
                        experimentalFeaturesEnabled ? (
                          <WorkbenchHarnessSelector
                            runtime={activeNewChatRuntime}
                            harnesses={localHarnesses}
                            enabledHarnesses={enabledLocalHarnesses.map(
                              preference => preference.id
                            )}
                            loading={localHarnessesLoading}
                            detectionFailed={localHarnessDetectionFailed}
                            onRuntimeChange={runtime => {
                              setCentralHarnessError(null)
                              setNewChatRuntime(runtime)
                            }}
                          />
                        ) : undefined
                      }
                      modelSelectorOverride={
                        selectedHarnessPreference ? (
                          <WorkbenchHarnessModelSelector
                            harnessId={selectedHarnessPreference.id}
                            models={harnessModelOptions}
                            selectedModel={selectedHarnessModel}
                            onModelChange={model => {
                              setLocalHarnessModelKeys(current => ({
                                ...current,
                                [selectedHarnessPreference.id]: model?.key ?? null,
                              }))
                              const localHarnesses = localHarnessPreferences.map(preference =>
                                preference.id === selectedHarnessPreference.id
                                  ? { ...preference, modelKey: model?.key ?? null }
                                  : preference
                              )
                              void updateAppPreferences({ localHarnesses }).catch(error => {
                                console.error('Failed to save harness model selection:', error)
                                setCentralHarnessError(
                                  t(
                                    'workbench.harness_model_save_failed',
                                    '编码工具模型选择保存失败'
                                  )
                                )
                              })
                            }}
                          />
                        ) : undefined
                      }
                      showWorkspaceMenu={showComposerProjectMenuAction}
                      queuedMessages={paneQueuedMessages}
                      guidanceMessages={paneGuidanceMessages}
                      codeComments={paneSession.codeCommentContexts}
                      cloudMentionCandidates={visibleCloudMentionCandidates}
                      cloudProjectCandidates={cloudProjectMentionCandidates}
                      cloudSpaceEnabled={
                        experimentalFeaturesEnabled && Boolean(services?.deliveryApi)
                      }
                      onSelectCloudProject={handleSelectCloudProject}
                      isStreaming={paneIsBusy}
                      onPause={pauseCurrentResponse}
                      onCompactContext={
                        activeNewChatRuntime === 'codex' || activeNewChatRuntime === 'claude_code'
                          ? compactCurrentContext
                          : undefined
                      }
                      goal={paneSession.goal}
                      goalContinuing={paneSession.goalContinuing}
                      goalExecutionStatus={paneSession.goalExecutionStatus}
                      eventSubscriptionScope={eventSubscriptionScope}
                      onCancelEventSubscription={cancelCurrentEventSubscription}
                      eventCancellationUnsupported={eventCancellationUnsupported}
                      eventCancellationUnavailable={activeDeviceUnavailable || !deviceApi}
                      eventSubscriptions={connectionEventSubscriptions}
                      interactionStatus={runtimeTaskSummary?.interactionStatus}
                      taskPlan={paneSession.taskPlan}
                      goalDraftActive={paneSession.goalDraftActive}
                      onSetGoal={composerSupportsGoal ? setCurrentGoal : undefined}
                      onConfigureSupervisor={
                        supervisorFeatureAvailable ? openSupervisorDialog : undefined
                      }
                      supervisorEnabled={Boolean(supervisor || pendingSupervisorConfig)}
                      supervisorPending={Boolean(!currentRuntimeTask && pendingSupervisorConfig)}
                      onCancelGoalDraft={paneSession.cancelGoalDraft}
                      onEditGoal={paneSession.editCurrentGoal}
                      onPauseGoal={pauseCurrentGoal}
                      onResumeGoal={resumeCurrentGoal}
                      onClearGoal={clearCurrentGoal}
                      onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                      onForceStartQueuedMessage={paneSession.forceStartQueuedMessage}
                      onReorderQueuedMessages={paneSession.reorderQueuedMessages}
                      queuePaused={paneSession.queuedMessagesPaused}
                      onResumeQueue={paneSession.resumeQueuedMessages}
                      onResumeQueueWithInput={paneSession.resumeQueuedMessagesWithInput}
                      onClearQueue={paneSession.clearQueuedMessages}
                      onSendQueuedAsGuidance={
                        activeNewChatRuntime === 'codex'
                          ? paneSession.sendQueuedAsGuidance
                          : undefined
                      }
                      onInterruptAndSendQueuedMessage={paneSession.interruptAndSendQueued}
                      onEditQueuedMessage={paneSession.editQueuedMessage}
                      onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                      onClearCodeComments={paneSession.clearCodeComments}
                      onOpenSkillFile={openLocalSkillFile}
                      workspaceTarget={composerWorkspaceTarget}
                      workspaceFileApi={workspaceFileApi}
                    />
                  </>
                )
              }
            />
          )}
          <div
            aria-hidden="true"
            data-testid="environment-info-panel-spacer"
            className={cn(
              'w-0 shrink-0',
              environmentInfoPanelExpanded && 'w-[320px]',
              'transition-none'
            )}
          />
        </div>
      </>
    </TaskDetailScrollArea>
  )
}
