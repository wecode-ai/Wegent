import { useEffect, useMemo } from 'react'
import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useAuth } from '@/features/auth/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { navigateTo } from '@/lib/navigation'
import { buildTrayMenuTaskGroups } from '@/tauri/trayMenuState'
import { syncTrayMenuState } from '@/tauri/trayNavigation'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { logout } = useAuth()
  const {
    state,
    messages,
    queuedMessages,
    guidanceMessages,
    codeCommentContexts,
    workspaceFileApi,
    currentRuntimeTaskRunning,
    cloudWorkStatus,
    isAwaitingAssistantStart,
    isRuntimeTranscriptLoading,
    runtimeTranscriptHasMoreBefore,
    isRuntimeTranscriptLoadingMore,
    upgradingDevices,
    projectExecutionMode,
    setProjectExecutionMode,
    projectWorktreeBaseBranch,
    setProjectWorktreeBaseBranch,
    projectChat,
    selectProject,
    selectProjectWorkspace,
    selectStandaloneDevice,
    openStandaloneWorkspace,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeLocalTask,
    searchRuntimeWork,
    loadOlderRuntimeTranscript,
    renameRuntimeLocalTask,
    archiveRuntimeLocalTask,
    archiveProjectConversations,
    archiveProjectsConversations,
    archiveChatConversations,
    forkCurrentRuntimeTask,
    rememberExecutionDevice,
    refreshDevices,
    getRemoteDeviceStartupCommand,
    refreshWorkLists,
    upgradeDevice,
    createProject,
    createGitWorkspaceProject,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    removeProject,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    loadEnvironmentInfo,
    loadEnvironmentDiff,
    commitEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    listImPrivateSessions,
    bindRuntimeTaskToImSessions,
    getImNotificationSettings,
    updateGlobalImNotification,
    subscribeRuntimeTaskNotifications,
    unsubscribeRuntimeTaskNotifications,
    setInput,
    addCodeCommentContext,
    clearCodeCommentContexts,
    sendCurrentInput,
    retryFailedMessage,
    pauseCurrentResponse,
    isResponseStreaming,
    cancelQueuedMessage,
    sendQueuedAsGuidance,
    editQueuedMessage,
    cancelGuidanceMessage,
    loadTurnFileChangesDiff,
    revertTurnFileChanges,
  } = useWorkbench()
  const trayMenuTaskGroups = useMemo(
    () => buildTrayMenuTaskGroups(state.runtimeWork),
    [state.runtimeWork]
  )

  useEffect(() => {
    syncTrayMenuState(trayMenuTaskGroups)
  }, [trayMenuTaskGroups])

  const Layout = isMobile ? MobileWorkbenchLayout : DesktopWorkbenchLayout
  const projectWork = {
    projects: state.projects,
    devices: state.devices,
    runtimeWork: state.runtimeWork,
    currentProject: state.currentProject,
    currentProjectId: state.currentProject?.id,
    currentStandaloneDeviceId: state.standaloneDeviceId,
    selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
    pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
    executionMode: projectExecutionMode,
    executionModeLocked: Boolean(state.currentRuntimeTask),
    onSelectProject: selectProject,
    onSelectStandaloneDevice: selectStandaloneDevice,
    onSelectProjectWorkspace: selectProjectWorkspace,
    onBindProjectWorkspace: (projectId: number) => {
      selectProject(projectId)
    },
    onExecutionModeChange: setProjectExecutionMode,
    worktreeBaseBranch: projectWorktreeBaseBranch,
    onWorktreeBaseBranchChange: setProjectWorktreeBaseBranch,
  }

  return (
    <Layout
      state={state}
      messages={messages}
      queuedMessages={queuedMessages}
      guidanceMessages={guidanceMessages}
      codeCommentContexts={codeCommentContexts}
      workspaceFileApi={workspaceFileApi}
      currentRuntimeTaskRunning={currentRuntimeTaskRunning}
      cloudWorkStatus={cloudWorkStatus}
      isAwaitingAssistantStart={isAwaitingAssistantStart}
      isRuntimeTranscriptLoading={isRuntimeTranscriptLoading}
      runtimeTranscriptHasMoreBefore={runtimeTranscriptHasMoreBefore}
      isRuntimeTranscriptLoadingMore={isRuntimeTranscriptLoadingMore}
      upgradingDevices={upgradingDevices}
      onNewChat={startNewChat}
      onStartStandaloneChat={startStandaloneChat}
      onOpenPlugins={() => navigateTo('/plugins')}
      projectChat={projectChat}
      projectWork={projectWork}
      onSelectProject={selectProject}
      onStartNewProjectChat={startNewProjectChat}
      onOpenRuntimeLocalTask={openRuntimeLocalTask}
      onSearchRuntimeWork={searchRuntimeWork}
      onLoadOlderRuntimeTranscript={loadOlderRuntimeTranscript}
      onRenameRuntimeLocalTask={renameRuntimeLocalTask}
      onArchiveRuntimeLocalTask={archiveRuntimeLocalTask}
      onArchiveProjectConversations={archiveProjectConversations}
      onArchiveProjectsConversations={archiveProjectsConversations}
      onArchiveChatConversations={archiveChatConversations}
      onForkCurrentRuntimeTask={forkCurrentRuntimeTask}
      onRememberExecutionDevice={rememberExecutionDevice}
      onOpenStandaloneWorkspace={openStandaloneWorkspace}
      onGetRemoteDeviceStartupCommand={getRemoteDeviceStartupCommand}
      onRefreshDevices={refreshDevices}
      onUpgradeDevice={upgradeDevice}
      onCreateProject={createProject}
      onCreateGitWorkspaceProject={createGitWorkspaceProject}
      onPrepareDeviceWorkspace={prepareDeviceWorkspace}
      onDeleteDeviceWorkspace={deleteDeviceWorkspace}
      onListGitRepositories={listGitRepositories}
      onListGitBranches={listGitBranches}
      onUpdateProjectName={updateProjectName}
      onRemoveProject={removeProject}
      onGetDeviceHomeDirectory={getDeviceHomeDirectory}
      onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
      onListDeviceDirectories={listDeviceDirectories}
      onCreateDeviceDirectory={createDeviceDirectory}
      onLoadEnvironmentInfo={loadEnvironmentInfo}
      onLoadEnvironmentDiff={loadEnvironmentDiff}
      onCommitEnvironmentChanges={commitEnvironmentChanges}
      onListEnvironmentBranches={listEnvironmentBranches}
      onCheckoutEnvironmentBranch={checkoutEnvironmentBranch}
      onCreateEnvironmentBranch={createEnvironmentBranch}
      onListImPrivateSessions={listImPrivateSessions}
      onBindRuntimeTaskToImSessions={bindRuntimeTaskToImSessions}
      onGetImNotificationSettings={getImNotificationSettings}
      onUpdateGlobalImNotification={updateGlobalImNotification}
      onSubscribeRuntimeTaskNotifications={subscribeRuntimeTaskNotifications}
      onUnsubscribeRuntimeTaskNotifications={unsubscribeRuntimeTaskNotifications}
      onInputChange={setInput}
      onSend={sendCurrentInput}
      onRetryFailedMessage={retryFailedMessage}
      isResponseStreaming={isResponseStreaming}
      onPauseResponse={pauseCurrentResponse}
      onCancelQueuedMessage={cancelQueuedMessage}
      onSendQueuedAsGuidance={sendQueuedAsGuidance}
      onEditQueuedMessage={editQueuedMessage}
      onCancelGuidanceMessage={cancelGuidanceMessage}
      onLoadFileChangesDiff={loadTurnFileChangesDiff}
      onRevertFileChanges={revertTurnFileChanges}
      onAddCodeComment={addCodeCommentContext}
      onClearCodeComments={clearCodeCommentContexts}
      onRefreshWorkLists={refreshWorkLists}
      onLogout={logout}
    />
  )
}
