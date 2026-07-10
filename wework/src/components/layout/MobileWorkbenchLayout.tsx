import { ArrowLeftRight, Bot, Menu, MessageCircle } from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import type { ProjectChatControls } from '@/components/chat/ChatInput'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { ModelSelector } from '@/components/chat/composer/ModelSelector'
import { ProjectWorkBar } from '@/components/chat/composer/ProjectWorkBar'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { stripAppBasePath } from '@/config/runtime'
import { useWorkbench, useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import {
  findWorkbenchDevice,
  getActiveWorkbenchDeviceId,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  isDeviceBelowWeWorkVersion,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { ConversationDeviceOfflineBanner } from './ConversationDeviceOfflineBanner'
import { DeviceStatusPrompt } from './DeviceStatusPrompt'
import { MobileDrawer } from './MobileDrawer'
import { ContinueInImDialog } from '@/components/chat/ContinueInImDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import {
  isImplementationPlanConfirmationResponse,
  isImplementationPlanRequestUserInput,
  requestUserInputPayloadKey,
} from '@/components/chat/requestUserInputMessages'
import { TaskForkDialog } from './TaskForkDialog'
import {
  CachedWorkbenchPaneStack,
  getRunningRuntimeWorkbenchPaneKeys,
  type WorkbenchPaneIdentity,
} from './workbenchPaneStack'
import { useWorkbenchPaneSession } from './useWorkbenchPaneSession'
import { useWorkbenchPaneEnvironment } from './useWorkbenchPaneEnvironment'
import { useWorkbenchProjectWorkControls } from './useWorkbenchProjectWorkControls'
import { useRuntimeTaskContinueInIm } from './useRuntimeTaskContinueInIm'
import { pendingRequestUserInputPayload } from './requestUserInputOverlay'
import { SubagentStatusIndicator } from './SubagentStatusIndicator'
import { BufferedChatInput } from './BufferedChatInput'
import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'

export function MobileWorkbenchLayout() {
  const { state } = useWorkbench()
  const activePane: WorkbenchPaneIdentity = {
    currentRuntimeTask: state.currentRuntimeTask,
    currentProject: state.currentProject,
    standaloneChatKey: state.standaloneChatKey,
  }
  const pinnedPaneKeys = useMemo(
    () => getRunningRuntimeWorkbenchPaneKeys(state.runtimeWork),
    [state.runtimeWork]
  )

  return (
    <CachedWorkbenchPaneStack
      activePane={activePane}
      maxPanes={1}
      pinnedKeys={pinnedPaneKeys}
      className="h-dvh"
      renderPane={renderMobileWorkbenchPane}
    />
  )
}

function renderMobileWorkbenchPane(pane: WorkbenchPaneIdentity) {
  return <MobileWorkbenchPane pane={pane} />
}

const MobileWorkbenchPane = memo(function MobileWorkbenchPane({
  pane,
}: {
  pane: WorkbenchPaneIdentity
}) {
  const {
    state,
    upgradingDevices,
    projectChat,
    upgradeDevice,
    retryFailedMessage,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
    forkCurrentRuntimeTask,
    startNewChat: onNewChat,
    runtimeTaskReminders,
    startStandaloneChat: onStartStandaloneChat,
    selectProject: onSelectProject,
    openRuntimeTask: onOpenRuntimeTask,
    createProject: onCreateProject,
    createGitWorkspaceProject: onCreateGitWorkspaceProject,
    prepareDeviceWorkspace: onPrepareDeviceWorkspace,
    deleteDeviceWorkspace: onDeleteDeviceWorkspace,
    listGitRepositories: onListGitRepositories,
    listGitBranches: onListGitBranches,
    updateProjectName: onUpdateProjectName,
    removeProject: onRemoveProject,
    getDeviceHomeDirectory: onGetDeviceHomeDirectory,
    getProjectWorkspaceRoot: onGetProjectWorkspaceRoot,
    listDeviceDirectories: onListDeviceDirectories,
    createDeviceDirectory: onCreateDeviceDirectory,
    refreshWorkLists: onRefreshWorkLists,
  } = useWorkbenchPaneContext()
  const { t } = useTranslation('common')
  const activeItem = 'chat'
  const taskReminders = runtimeTaskReminders ?? EMPTY_RUNTIME_TASK_REMINDERS
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [modelSelectorOpenSignal, setModelSelectorOpenSignal] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(() =>
    isSettingsRoute(stripAppBasePath(window.location.pathname))
  )
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [notice, setNotice] = useState<{
    message: string
    tone: 'success' | 'error'
  } | null>(null)
  const currentRuntimeTask = pane.currentRuntimeTask
  const paneSession = useWorkbenchPaneSession({ currentRuntimeTask })
  const continueInIm = useRuntimeTaskContinueInIm(currentRuntimeTask)
  const activePaneProject = pane.currentProject
  const paneMessages = paneSession.messages
  const pendingRequestUserInput = pendingRequestUserInputPayload(
    paneMessages,
    paneSession.answeredRequestUserInputIds
  )
  const paneQueuedMessages = paneSession.queuedMessages
  const paneGuidanceMessages = paneSession.guidanceMessages
  const paneIsResponseStreaming = paneSession.status.isAssistantStreaming
  const hasConversation = paneMessages.length > 0 || currentRuntimeTask
  const activeConversationProject = activePaneProject
  const effectiveProjectChat = projectChat ?? {
    models: [],
    selectedModel: null,
    selectedModelOptions: {},
    isModelSelectionReady: true,
    isOptionsLocked: false,
    setSelectedModel: () => {},
    setSelectedModelOption: () => {},
  }
  const projectChatWithModelSelectorSignal: ProjectChatControls = {
    ...effectiveProjectChat,
    modelSelectorOpenSignal,
  }
  const emptyTitle = activeConversationProject
    ? t('workbench.project_empty_title', {
        defaultValue: `我们应该在 ${activeConversationProject.name} 中构建什么？`,
        projectName: activeConversationProject.name,
      })
    : t('workbench.empty_title', '我们该做什么？')
  const baseProjectWork = useWorkbenchProjectWorkControls({ pane })
  const { projectWork: effectiveProjectWork } = useWorkbenchPaneEnvironment({
    pane,
    projectWork: baseProjectWork,
  })
  const activeDeviceId =
    currentRuntimeTask?.deviceId ??
    getActiveWorkbenchDeviceId({
      currentProject: activeConversationProject,
      standaloneDeviceId: effectiveProjectWork.currentStandaloneDeviceId,
    })
  const activeDevice = findWorkbenchDevice(state.devices, activeDeviceId)
  const canEditLastUserMessage = Boolean(
    currentRuntimeTask &&
    (activeDevice?.device_type === 'local' || activeDeviceId === 'local-device') &&
    !paneSession.status.isBusy
  )
  const activeDeviceUnavailable = Boolean(activeDeviceId) && !isWorkbenchDeviceOnline(activeDevice)
  const showConversationDeviceBanner =
    Boolean(activeDeviceId) && (!activeDevice || activeDevice.status === 'offline')
  const activeDeviceVersionUnsupported = Boolean(
    activeDevice && isDeviceBelowWeWorkVersion(activeDevice)
  )
  const noStandaloneCompatibleDevice =
    !activeConversationProject &&
    !currentRuntimeTask &&
    !activeDeviceId &&
    !state.devices.some(device => device.status === 'online' && isWeWorkCompatibleDevice(device))
  const composerDisabled =
    paneSession.status.isSubmitting ||
    activeDeviceUnavailable ||
    activeDeviceVersionUnsupported ||
    noStandaloneCompatibleDevice
  const composerDisabledReason = activeDeviceUnavailable
    ? t('workbench.device_status_active_unavailable', {
        device: activeDevice?.name || activeDeviceId || t('workbench.project_device'),
      })
    : activeDeviceVersionUnsupported
      ? t('workbench.device_status_active_upgrade_required', {
          device: activeDevice?.name || activeDeviceId || t('workbench.project_device'),
          version: WEWORK_MIN_EXECUTOR_VERSION,
        })
      : noStandaloneCompatibleDevice
        ? t('workbench.device_status_no_online_device')
        : undefined
  const inlineComposerDisabledReason = showConversationDeviceBanner
    ? undefined
    : composerDisabledReason

  useEffect(() => {
    const handlePopState = () => {
      setSettingsOpen(isSettingsRoute(stripAppBasePath(window.location.pathname)))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  if (settingsOpen) {
    return (
      <MobileSettingsPage
        onBack={() => {
          setSettingsOpen(false)
          navigateTo('/')
        }}
        onOpenPlugins={() => navigateTo('/plugins')}
      />
    )
  }

  if (state.isBootstrapping) {
    return (
      <div className="flex h-full overflow-hidden bg-background text-text-primary">
        <main
          className="flex h-full min-h-0 w-full flex-col overflow-hidden"
          data-testid="mobile-workbench-loading"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden bg-background text-text-primary">
      <main className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        {hasConversation ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <header
              data-testid="mobile-conversation-header"
              className="pointer-events-none absolute left-0 right-0 top-0 z-chrome flex min-h-[56px] items-center gap-2 border-b border-border/60 bg-background/95 px-3 pb-2 pt-[max(6px,env(safe-area-inset-top))] backdrop-blur"
            >
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="pointer-events-auto flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="pointer-events-auto flex min-w-0 flex-1 justify-start">
                {(effectiveProjectChat.isModelSelectionReady ?? true) ? (
                  <ModelSelector
                    models={effectiveProjectChat.models}
                    selectedModel={effectiveProjectChat.selectedModel}
                    selectedModelOptions={effectiveProjectChat.selectedModelOptions}
                    openSignal={modelSelectorOpenSignal}
                    disabled={false}
                    onSelectModel={effectiveProjectChat.setSelectedModel}
                    onSelectModelOption={effectiveProjectChat.setSelectedModelOption}
                    onBlockedModelSelect={effectiveProjectChat.onBlockedModelSelect}
                    menuPlacement="below"
                    buttonClassName="max-w-[min(14rem,calc(100vw-6rem))] bg-surface px-3"
                    menuClassName="left-0 right-auto w-[min(34rem,calc(100vw-2rem))]"
                  />
                ) : (
                  <div className="h-10 w-32" data-testid="model-selector-loading" />
                )}
              </div>
              {currentRuntimeTask ? (
                <div className="pointer-events-auto flex items-center gap-1">
                  <SubagentStatusIndicator
                    statuses={paneSession.subagentStatuses}
                    availableWidth={0}
                    compact
                  />
                  <button
                    type="button"
                    data-testid="mobile-fork-runtime-task-button"
                    className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                    aria-label={t('workbench.task_fork_title', '复制任务')}
                    onClick={() => setForkDialogOpen(true)}
                  >
                    <ArrowLeftRight className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    data-testid="mobile-continue-in-im-button"
                    className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                    aria-label={t('workbench.continue_im_title')}
                    onClick={continueInIm.openDialog}
                  >
                    <MessageCircle className="h-5 w-5" />
                  </button>
                </div>
              ) : (
                <div className="h-11 min-w-[44px]" />
              )}
            </header>
            <ScrollableMessageArea
              messages={paneMessages}
              loading={paneSession.transcriptLoading}
              isWaitingForAssistant={paneSession.status.isWaitingForAssistantIndicator}
              hasMoreBefore={paneSession.transcriptHasMoreBefore}
              loadingMoreBefore={paneSession.transcriptLoadingMoreBefore}
              turnNavigation={paneSession.turnNavigation}
              onLoadMoreBefore={paneSession.loadMoreTranscriptBefore}
              onLoadFullTranscript={paneSession.loadFullTranscript}
              loadingFullTranscript={paneSession.transcriptLoadingFullContent}
              onLoadTurnNavigationItem={paneSession.loadTranscriptTurnNavigationItem}
              onLoadTranscriptGap={paneSession.loadTranscriptGap}
              conversationKey={
                currentRuntimeTask
                  ? `${currentRuntimeTask.deviceId}:${currentRuntimeTask.taskId}`
                  : null
              }
              className="h-full"
              scrollerClassName="pb-28 pt-16"
              devices={state.devices}
              onRetryFailedMessage={message => {
                void retryFailedMessage(message.id, paneMessages)
              }}
              onSwitchModelForFailedMessage={() => setModelSelectorOpenSignal(signal => signal + 1)}
              onLoadFileChangesDiff={(subtaskId, fileChanges) =>
                loadTurnFileChangesDiff(subtaskId, paneMessages, fileChanges)
              }
              onRevertFileChanges={(subtaskId, fileChanges) =>
                revertTurnFileChanges(subtaskId, paneMessages, fileChanges)
              }
              onEditLastUserMessage={paneSession.editLastUserMessage}
              canEditLastUserMessage={canEditLastUserMessage}
              onRequestUserInputSubmit={paneSession.sendRequestUserInputResponse}
              onRequestUserInputIgnore={paneSession.ignoreRequestUserInput}
              hideRequestUserInputBlocks={Boolean(pendingRequestUserInput)}
              hiddenRequestUserInputIds={paneSession.answeredRequestUserInputIds}
            />
            <div
              data-testid="mobile-chat-input-dock"
              className="pointer-events-none absolute bottom-0 left-0 right-0 z-chrome px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3"
            >
              <div className="pointer-events-auto">
                {showConversationDeviceBanner ? (
                  <ConversationDeviceOfflineBanner
                    device={activeDevice}
                    deviceId={activeDeviceId}
                    className="mb-2"
                  />
                ) : (
                  <DeviceStatusPrompt
                    devices={state.devices}
                    upgradingDevices={upgradingDevices}
                    onUpgradeDevice={upgradeDevice}
                    onOpenCloudDeviceSettings={() => navigateTo('/settings/connections')}
                    activeDeviceId={activeDeviceId}
                    requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                    compact
                    className="mb-2"
                  />
                )}
                {pendingRequestUserInput ? (
                  <RequestUserInputCard
                    key={
                      requestUserInputPayloadKey(pendingRequestUserInput) ?? 'implementation-plan'
                    }
                    payload={pendingRequestUserInput}
                    onSubmit={response => {
                      const isImplementationPlanRequest =
                        isImplementationPlanRequestUserInput(pendingRequestUserInput)
                      const shouldImplementPlan =
                        isImplementationPlanRequest &&
                        isImplementationPlanConfirmationResponse(response)
                      return paneSession.sendRequestUserInputResponse(response, {
                        appendUserMessage: isImplementationPlanRequest,
                        forceDefaultCollaborationMode: shouldImplementPlan,
                      })
                    }}
                    onIgnore={() => paneSession.ignoreRequestUserInput(pendingRequestUserInput)}
                  />
                ) : (
                  <BufferedChatInput
                    value={paneSession.input}
                    onChange={paneSession.setInput}
                    onSubmit={paneSession.send}
                    disabled={composerDisabled}
                    error={paneSession.error}
                    disabledReason={inlineComposerDisabledReason}
                    placeholder={t('workbench.follow_up_placeholder', '要求后续变更')}
                    projectChat={projectChatWithModelSelectorSignal}
                    projectWork={effectiveProjectWork}
                    queuedMessages={paneQueuedMessages}
                    guidanceMessages={paneGuidanceMessages}
                    codeComments={paneSession.codeCommentContexts}
                    isStreaming={paneIsResponseStreaming}
                    onPause={() => void paneSession.pauseCurrentResponse()}
                    onCompactContext={() => void paneSession.compactContext()}
                    onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                    onSendQueuedAsGuidance={paneSession.sendQueuedAsGuidance}
                    onEditQueuedMessage={paneSession.editQueuedMessage}
                    onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                    onClearCodeComments={paneSession.clearCodeComments}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col pb-[max(16px,env(safe-area-inset-bottom))]">
            <header
              data-testid="mobile-empty-header"
              className="flex min-h-[56px] shrink-0 items-center gap-2 border-b border-transparent bg-background/95 px-3 pb-2 pt-[max(6px,env(safe-area-inset-top))]"
            >
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-text-primary hover:bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="flex min-w-0 flex-1 justify-start">
                {(effectiveProjectChat.isModelSelectionReady ?? true) ? (
                  <ModelSelector
                    models={effectiveProjectChat.models}
                    selectedModel={effectiveProjectChat.selectedModel}
                    selectedModelOptions={effectiveProjectChat.selectedModelOptions}
                    openSignal={modelSelectorOpenSignal}
                    disabled={false}
                    onSelectModel={effectiveProjectChat.setSelectedModel}
                    onSelectModelOption={effectiveProjectChat.setSelectedModelOption}
                    onBlockedModelSelect={effectiveProjectChat.onBlockedModelSelect}
                    menuPlacement="below"
                    buttonClassName="max-w-[min(14rem,calc(100vw-6rem))] bg-surface px-3"
                    menuClassName="left-0 right-auto w-[min(34rem,calc(100vw-2rem))]"
                  />
                ) : (
                  <div className="h-10 w-32" data-testid="model-selector-loading" />
                )}
              </div>
              <div className="h-11 min-w-[44px]" />
            </header>

            <section className="flex min-h-0 flex-1 items-center justify-center px-5 pb-6">
              <div
                data-testid="mobile-empty-state-content"
                className="flex w-full max-w-[360px] flex-col items-center gap-6"
              >
                <Bot className="h-8 w-8 text-text-muted" />
                <h1 className="text-center text-2xl font-semibold tracking-normal">{emptyTitle}</h1>
                <ProjectWorkBar
                  {...effectiveProjectWork}
                  className="min-h-0 flex-col justify-center gap-1 px-0"
                  buttonClassName="bg-surface px-4 text-text-primary"
                  menuClassName="left-1/2 w-[min(20rem,calc(100vw-2.5rem))] -translate-x-1/2"
                  emptyLabel={t('workbench.select_project', '选择项目')}
                />
              </div>
            </section>
            <div data-testid="mobile-empty-chat-input-dock" className="px-4 pb-0 pt-3">
              <DeviceStatusPrompt
                devices={state.devices}
                upgradingDevices={upgradingDevices}
                onUpgradeDevice={upgradeDevice}
                onOpenCloudDeviceSettings={() => navigateTo('/settings/connections')}
                activeDeviceId={activeDeviceId}
                requiresOnlineCompatibleDevice={noStandaloneCompatibleDevice}
                compact
                className="mb-2"
              />
              <BufferedChatInput
                value={paneSession.input}
                onChange={paneSession.setInput}
                onSubmit={paneSession.send}
                disabled={composerDisabled}
                error={paneSession.error}
                disabledReason={inlineComposerDisabledReason}
                placeholder={t('workbench.mobile_input_placeholder', '询问 Wework')}
                projectChat={projectChatWithModelSelectorSignal}
                projectWork={effectiveProjectWork}
                queuedMessages={paneQueuedMessages}
                guidanceMessages={paneGuidanceMessages}
                codeComments={paneSession.codeCommentContexts}
                isStreaming={paneIsResponseStreaming}
                onPause={() => void paneSession.pauseCurrentResponse()}
                onCompactContext={() => void paneSession.compactContext()}
                onCancelQueuedMessage={paneSession.cancelQueuedMessage}
                onSendQueuedAsGuidance={paneSession.sendQueuedAsGuidance}
                onEditQueuedMessage={paneSession.editQueuedMessage}
                onCancelGuidanceMessage={paneSession.cancelGuidanceMessage}
                onClearCodeComments={paneSession.clearCodeComments}
              />
            </div>
          </div>
        )}
      </main>

      <MobileDrawer
        open={drawerOpen}
        user={state.user}
        devices={state.devices}
        projects={state.projects}
        runtimeWork={state.runtimeWork}
        currentProjectId={activeConversationProject?.id}
        currentRuntimeTask={currentRuntimeTask}
        unreadRuntimeTaskKeys={taskReminders.unreadTaskKeys}
        activeItem={activeItem}
        onClose={() => setDrawerOpen(false)}
        onNewChat={onNewChat}
        onStartStandaloneChat={onStartStandaloneChat}
        onOpenSettings={() => {
          setSettingsOpen(true)
          navigateTo('/settings')
        }}
        onCreateProject={onCreateProject}
        onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
        onListGitRepositories={onListGitRepositories}
        onListGitBranches={onListGitBranches}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onUpdateProjectName={onUpdateProjectName}
        onRemoveProject={onRemoveProject}
        onSelectProject={onSelectProject}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onRefreshWorkLists={onRefreshWorkLists}
      />
      <ContinueInImDialog
        key={continueInIm.dialog.open ? 'continue-im-open' : 'continue-im-closed'}
        {...continueInIm.dialog}
      />
      <TaskForkDialog
        key={forkDialogOpen ? `open-${currentRuntimeTask?.taskId ?? 'none'}` : 'closed'}
        open={forkDialogOpen}
        source={currentRuntimeTask}
        runtimeWork={state.runtimeWork}
        currentProject={activeConversationProject}
        devices={state.devices}
        requiresStop={paneIsResponseStreaming}
        onOpenChange={setForkDialogOpen}
        onStopCurrentResponse={() => paneSession.pauseCurrentResponse()}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onDeleteDeviceWorkspace={onDeleteDeviceWorkspace}
        onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
        onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot}
        onListDeviceDirectories={onListDeviceDirectories}
        onCreateDeviceDirectory={onCreateDeviceDirectory}
        onFork={async target => {
          await forkCurrentRuntimeTask(target)
        }}
      />
      <TransientNotice
        message={notice?.message ?? continueInIm.notice?.message ?? null}
        tone={notice?.tone ?? continueInIm.notice?.tone}
        onClear={() => {
          setNotice(null)
          continueInIm.clearNotice()
        }}
      />
    </div>
  )
})
