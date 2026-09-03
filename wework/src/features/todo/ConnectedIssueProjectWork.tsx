import { useMemo, type ReactNode } from 'react'
import type { ProjectWorkControls } from '@/components/chat/ChatInput'
import { useWorkbenchPaneEnvironment } from '@/components/layout/useWorkbenchPaneEnvironment'
import { useWorkbenchProjectWorkControls } from '@/components/layout/useWorkbenchProjectWorkControls'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type { ProjectExecutionMode, ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'

interface ConnectedIssueProjectWorkProps {
  project: ProjectWithTasks
  selectedDeviceWorkspaceId: number | null
  executionMode?: ProjectExecutionMode
  worktreeBranch?: string | null
  onSelectProject: (projectId: number | null) => void
  onSelectProjectWorkspace: (projectId: number, deviceWorkspaceId: number | null) => void
  onExecutionModeChange?: (mode: ProjectExecutionMode) => void
  onWorktreeBranchChange?: (branchName: string | null) => void
  inheritFromTask?: RuntimeTaskAddress | null
  children: (projectWork: ProjectWorkControls) => ReactNode
}

export function ConnectedIssueProjectWork({
  project,
  selectedDeviceWorkspaceId,
  executionMode,
  worktreeBranch,
  onSelectProject,
  onSelectProjectWorkspace,
  onExecutionModeChange,
  onWorktreeBranchChange,
  inheritFromTask = null,
  children,
}: ConnectedIssueProjectWorkProps) {
  const { state } = useWorkbenchPaneContext()
  const resolvedProject = useMemo<ProjectWithTasks>(() => {
    const stateProject = state.projects.find(candidate => candidate.id === project.id) ?? project
    if (stateProject.config?.mode === 'workspace') return stateProject
    const runtimeProject = state.runtimeWork?.projects.find(
      candidate => runtimeProjectUiId(candidate.project) === project.id
    )
    const workspace =
      runtimeProject?.deviceWorkspaces.find(candidate => candidate.available) ??
      runtimeProject?.deviceWorkspaces[0]
    if (!workspace?.workspacePath || !workspace.deviceId) return stateProject
    return {
      ...stateProject,
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local',
          deviceId: workspace.deviceId,
        },
        workspace: {
          source: 'local_path',
          localPath: workspace.workspacePath,
        },
      },
    }
  }, [project, state.projects, state.runtimeWork])
  const pane = useMemo(
    () => ({
      currentRuntimeTask: inheritFromTask,
      currentProject: resolvedProject,
    }),
    [inheritFromTask, resolvedProject]
  )
  const baseProjectWork = useWorkbenchProjectWorkControls({
    pane,
    enableShellProjectActions: true,
  })
  const { projectWork } = useWorkbenchPaneEnvironment({
    pane,
    projectWork: baseProjectWork,
  })
  const connectedProjectWork = useMemo<ProjectWorkControls>(
    () => ({
      ...projectWork,
      currentProject: resolvedProject,
      currentProjectId: resolvedProject.id,
      selectedDeviceWorkspaceId,
      pendingProjectWorkspaceProjectId: null,
      executionMode: executionMode ?? projectWork.executionMode,
      worktreeBranch: worktreeBranch ?? projectWork.worktreeBranch,
      showProjectClearButton: false,
      onSelectProject,
      onSelectProjectWorkspace,
      onExecutionModeChange: onExecutionModeChange ?? projectWork.onExecutionModeChange,
      onWorktreeBranchChange: onWorktreeBranchChange ?? projectWork.onWorktreeBranchChange,
    }),
    [
      executionMode,
      onSelectProject,
      onSelectProjectWorkspace,
      onExecutionModeChange,
      onWorktreeBranchChange,
      projectWork,
      resolvedProject,
      selectedDeviceWorkspaceId,
      worktreeBranch,
    ]
  )

  return children(connectedProjectWork)
}
