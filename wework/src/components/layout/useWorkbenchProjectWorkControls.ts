import { useMemo } from 'react'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import type { WorkbenchPaneIdentity } from './workbenchPaneStack'
import { requestProjectCreateMode, requestProjectWorkspaceBinding } from './workbenchShellEvents'

export function useWorkbenchProjectWorkControls({
  pane,
  enableShellProjectActions = false,
}: {
  pane: WorkbenchPaneIdentity
  enableShellProjectActions?: boolean
}): ProjectWorkControls {
  const {
    state,
    projectExecutionMode,
    setProjectExecutionMode,
    projectWorktreeBranch,
    setProjectWorktreeBranch,
    selectProject,
    selectProjectWorkspace,
    selectStandaloneDevice,
  } = useWorkbenchPaneContext()
  const currentProject = pane.currentProject

  return useMemo(
    () => ({
      projects: state.projects,
      devices: state.devices,
      runtimeWork: state.runtimeWork,
      currentProject,
      currentProjectId: currentProject?.id,
      currentStandaloneDeviceId: state.standaloneDeviceId,
      selectedDeviceWorkspaceId: state.selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId: state.pendingProjectWorkspaceProjectId,
      executionMode: projectExecutionMode,
      executionModeLocked: Boolean(pane.currentRuntimeTask),
      onSelectProject: selectProject,
      onSelectStandaloneDevice: selectStandaloneDevice,
      onSelectProjectWorkspace: selectProjectWorkspace,
      onBindProjectWorkspace: enableShellProjectActions
        ? requestProjectWorkspaceBinding
        : (projectId: number) => {
            selectProject(projectId)
          },
      onExecutionModeChange: setProjectExecutionMode,
      onCreateProjectMode: enableShellProjectActions ? requestProjectCreateMode : undefined,
      worktreeBranch: projectWorktreeBranch,
      onWorktreeBranchChange: setProjectWorktreeBranch,
    }),
    [
      currentProject,
      enableShellProjectActions,
      pane.currentRuntimeTask,
      projectExecutionMode,
      projectWorktreeBranch,
      selectProject,
      selectProjectWorkspace,
      selectStandaloneDevice,
      setProjectExecutionMode,
      setProjectWorktreeBranch,
      state.devices,
      state.pendingProjectWorkspaceProjectId,
      state.projects,
      state.runtimeWork,
      state.selectedDeviceWorkspaceId,
      state.standaloneDeviceId,
    ]
  )
}
