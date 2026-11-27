import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { resolveRuntimeTaskProjects } from '@/lib/runtime-project'
import { runtimeTaskProjectUiId } from '@/lib/runtime-task-workspace-binding'
import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import { createProjectRuntimeTaskComposer } from './useProjectRuntimeTaskComposer'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'

export interface BackgroundTaskRequest {
  project: CloudProject
  localProjects: ProjectWithTasks[]
  task: CloudLoopItem
  input: string
  initialLocalProjectId?: number | null
  initialDeviceWorkspaceId?: number | null
  taskRequest?: RuntimeTaskCreateRequest | null
  inheritFromTask?: RuntimeTaskAddress | null
  prepareTask?: (
    address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  onTaskCreated?: (
    address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null,
    deviceWorkspaceId: number | null
  ) => Promise<void> | void
  onAddressChange: (address: RuntimeTaskAddress) => void
  onError: (message: string) => void
}

export async function startBackgroundTask(
  props: BackgroundTaskRequest,
  workbench: Pick<WorkbenchContextValue, 'state' | 'createProjectRuntimeTask'>
) {
  const {
    project,
    localProjects,
    task,
    input,
    initialLocalProjectId = null,
    initialDeviceWorkspaceId = null,
    taskRequest = null,
    inheritFromTask = null,
    prepareTask,
    onTaskCreated,
    onAddressChange,
    onError,
  } = props
  const runtimeTaskProjects = resolveRuntimeTaskProjects(localProjects, workbench.state.runtimeWork)
  const requestedProjectId = runtimeTaskProjectUiId(workbench.state.runtimeWork, taskRequest)
  const selectedLocalProject =
    runtimeTaskProjects.find(candidate => candidate.id === requestedProjectId) ??
    runtimeTaskProjects.find(candidate => candidate.id === initialLocalProjectId) ??
    runtimeTaskProjects.find(candidate => String(candidate.id) === String(project.id)) ??
    runtimeTaskProjects[0] ??
    null
  const createConversation = createProjectRuntimeTaskComposer(workbench.createProjectRuntimeTask, {
    project: selectedLocalProject,
    deviceWorkspaceId: taskRequest?.deviceWorkspaceId ?? initialDeviceWorkspaceId,
    workspaceSource: inheritFromTask,
    taskRequest,
    runtimeContext: buildWorkItemRuntimeContext(project, task),
    prepareTask,
    onTaskCreated,
  })
  let reported = false
  const reportAddress = (address: RuntimeTaskAddress) => {
    if (reported) return
    reported = true
    onAddressChange(address)
  }
  const address = await createConversation(input, {
    attachments: [],
    executionModel: {},
    optimisticUserMessage: createRuntimeUserMessage(input, []),
    onError,
    onRuntimeTaskOptimisticOpen: reportAddress,
  })
  if (address) reportAddress(address)
  return address
}
