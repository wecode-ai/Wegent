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
    runningTaskIds,
    upgradingDevices,
    projectExecutionMode,
    setProjectExecutionMode,
    projectChat,
    selectProject,
    selectStandaloneDevice,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openTask,
    searchTasks,
    searchTaskDetail,
    rememberExecutionDevice,
    refreshDevices,
    upgradeDevice,
    createProject,
    createGitWorkspaceProject,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    removeProject,
    archiveAllChats,
    archiveAllProjectChats,
    archiveProjectChats,
    archiveTask,
    renameTask,
    listArchivedTasks,
    unarchiveTask,
    deleteTask,
    deleteArchivedTasks,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    loadEnvironmentInfo,
    commitEnvironmentChanges,
    listEnvironmentBranches,
    checkoutEnvironmentBranch,
    createEnvironmentBranch,
    setInput,
    sendCurrentInput,
    pauseCurrentResponse,
    isResponseStreaming,
    cancelQueuedMessage,
    sendQueuedAsGuidance,
    editQueuedMessage,
    cancelGuidanceMessage,
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
  }

  return (
    <Layout
      state={state}
      messages={messages}
      queuedMessages={queuedMessages}
      guidanceMessages={guidanceMessages}
      runningTaskIds={runningTaskIds}
      upgradingDevices={upgradingDevices}
      onNewChat={startNewChat}
      onStartStandaloneChat={startStandaloneChat}
      onOpenPlugins={() => navigateTo('/plugins')}
      projectChat={projectChat}
      projectWork={projectWork}
      onSelectProject={selectProject}
      onStartNewProjectChat={startNewProjectChat}
      onOpenTask={openTask}
      onSearchTasks={searchTasks}
      onSearchTaskDetail={searchTaskDetail}
      onRememberExecutionDevice={rememberExecutionDevice}
      onRefreshDevices={refreshDevices}
      onUpgradeDevice={upgradeDevice}
      onCreateProject={createProject}
      onCreateGitWorkspaceProject={createGitWorkspaceProject}
      onListGitRepositories={listGitRepositories}
      onListGitBranches={listGitBranches}
      onUpdateProjectName={updateProjectName}
      onRemoveProject={removeProject}
      onArchiveAllChats={archiveAllChats}
      onArchiveAllProjectChats={archiveAllProjectChats}
      onArchiveProjectChats={archiveProjectChats}
      onArchiveTask={archiveTask}
      onRenameTask={renameTask}
      onListArchivedTasks={listArchivedTasks}
      onUnarchiveTask={unarchiveTask}
      onDeleteTask={deleteTask}
      onDeleteArchivedTasks={deleteArchivedTasks}
      onGetDeviceHomeDirectory={getDeviceHomeDirectory}
      onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
      onListDeviceDirectories={listDeviceDirectories}
      onCreateDeviceDirectory={createDeviceDirectory}
      onLoadEnvironmentInfo={loadEnvironmentInfo}
      onCommitEnvironmentChanges={commitEnvironmentChanges}
      onListEnvironmentBranches={listEnvironmentBranches}
      onCheckoutEnvironmentBranch={checkoutEnvironmentBranch}
      onCreateEnvironmentBranch={createEnvironmentBranch}
      onInputChange={setInput}
      onSend={sendCurrentInput}
      isResponseStreaming={isResponseStreaming}
      onPauseResponse={pauseCurrentResponse}
      onCancelQueuedMessage={cancelQueuedMessage}
      onSendQueuedAsGuidance={sendQueuedAsGuidance}
      onEditQueuedMessage={editQueuedMessage}
      onCancelGuidanceMessage={cancelGuidanceMessage}
      onLogout={logout}
    />
  )
}
