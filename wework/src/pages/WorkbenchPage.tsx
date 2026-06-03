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
    createProject,
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
    loadEnvironmentInfo,
    commitEnvironmentChanges,
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
    onSelectProject: selectProject,
    onSelectStandaloneDevice: selectStandaloneDevice,
  }

  return (
    <Layout
      state={state}
      messages={messages}
      queuedMessages={queuedMessages}
      guidanceMessages={guidanceMessages}
      runningTaskIds={runningTaskIds}
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
      onCreateProject={createProject}
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
      onLoadEnvironmentInfo={loadEnvironmentInfo}
      onCommitEnvironmentChanges={commitEnvironmentChanges}
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
