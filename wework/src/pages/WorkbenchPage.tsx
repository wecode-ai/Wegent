import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useAuth } from '@/features/auth/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { navigateTo } from '@/lib/navigation'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { logout } = useAuth()
  const {
    state,
    messages,
    queuedMessages,
    guidanceMessages,
    codeCommentContexts,
    upgradingDevices,
    projectExecutionMode,
    setProjectExecutionMode,
    projectWorktreeBaseBranch,
    setProjectWorktreeBaseBranch,
    projectChat,
    selectProject,
    selectStandaloneDevice,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeLocalTask,
    archiveRuntimeLocalTask,
    forkCurrentRuntimeTask,
    rememberExecutionDevice,
    refreshDevices,
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
  const Layout = isMobile ? MobileWorkbenchLayout : DesktopWorkbenchLayout
  const projectWork = {
    projects: state.projects,
    devices: state.devices,
    currentProjectId: state.currentProject?.id,
    currentStandaloneDeviceId: state.standaloneDeviceId,
    executionMode: projectExecutionMode,
    executionModeLocked: Boolean(state.currentTask),
    onSelectProject: selectProject,
    onSelectStandaloneDevice: selectStandaloneDevice,
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
      upgradingDevices={upgradingDevices}
      onNewChat={startNewChat}
      onStartStandaloneChat={startStandaloneChat}
      onOpenPlugins={() => navigateTo('/plugins')}
      projectChat={projectChat}
      projectWork={projectWork}
      onSelectProject={selectProject}
      onStartNewProjectChat={startNewProjectChat}
      onOpenRuntimeLocalTask={openRuntimeLocalTask}
      onArchiveRuntimeLocalTask={archiveRuntimeLocalTask}
      onForkCurrentRuntimeTask={forkCurrentRuntimeTask}
      onRememberExecutionDevice={rememberExecutionDevice}
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
