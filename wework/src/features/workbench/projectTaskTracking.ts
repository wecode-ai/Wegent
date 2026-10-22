import type { WeworkWorkspaceRuntimePort, WorkspaceRuntimeTaskAddress } from '@wegent/collaboration'
import { modelSelectionFromRuntimeHandle } from '@wegent/chat-core/runtime-model-selection'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from './workbenchServices'

const projectStoreByRuntimeTask = new Map<string, 'backend' | 'local'>()
const cloudRuntimeApis = new WeakMap<WeworkWorkspaceRuntimePort, ProjectTaskRuntimeApi>()

export interface ProjectTaskRuntimeContext {
  project: CloudProject
  loop_item: CloudLoopItem | null
}

export interface ProjectTaskRuntimeApi {
  findCloudContextForTask(task: RuntimeTaskAddress): Promise<ProjectTaskRuntimeContext>
  bindTask(issueId: string, task: RuntimeTaskAddress, taskTitle?: string | null): Promise<void>
  unbindCloudContext(task: RuntimeTaskAddress): Promise<void>
  trackProjectTask(
    projectId: string,
    task: RuntimeTaskAddress,
    title: string,
    description: string
  ): Promise<{ item: CloudLoopItem }>
  updateTaskTrackingTitle(task: RuntimeTaskAddress, title: string): Promise<CloudLoopItem | null>
}

function runtimeTaskKey(address: RuntimeTaskAddress) {
  return `${address.deviceId}:${address.taskId}`
}

function runtimeTaskProjectStore(address: RuntimeTaskAddress): 'backend' | 'local' | undefined {
  const handle = address.runtimeHandle
  const origin =
    handle?.origin && typeof handle.origin === 'object'
      ? (handle.origin as Record<string, unknown>)
      : null
  const projectStore =
    handle?.projectStore ??
    handle?.project_store ??
    origin?.projectStore ??
    origin?.project_store ??
    projectStoreByRuntimeTask.get(runtimeTaskKey(address))
  return projectStore === 'backend' || projectStore === 'local' ? projectStore : undefined
}

function toCloudProject(
  project: Awaited<ReturnType<WeworkWorkspaceRuntimePort['findCloudContextForTask']>>['project']
): CloudProject {
  return {
    ...project,
    provider_config: project.provider_config as CloudProject['provider_config'],
  }
}

function toCloudLoopItem(
  issue: Awaited<ReturnType<WeworkWorkspaceRuntimePort['findIssueForTask']>>
): CloudLoopItem {
  return { ...issue, current_delivery_id: null } as unknown as CloudLoopItem
}

export function toWorkspaceRuntimeTaskAddress(
  task: RuntimeTaskAddress
): WorkspaceRuntimeTaskAddress {
  const modelSelection = modelSelectionFromRuntimeHandle(task.runtimeHandle)
  const team = task.runtimeHandle?.wegentTeam as { id?: number } | undefined
  return {
    deviceId: task.deviceId,
    taskId: task.taskId,
    ...(team?.id ? { wegentTeamId: team.id } : {}),
    ...(modelSelection ? { modelSelection: { ...modelSelection } } : {}),
  }
}

export function createCloudProjectTaskRuntimeApi(
  port: WeworkWorkspaceRuntimePort
): ProjectTaskRuntimeApi {
  const existing = cloudRuntimeApis.get(port)
  if (existing) return existing
  const api: ProjectTaskRuntimeApi = {
    async findCloudContextForTask(task) {
      const sharedTask = toWorkspaceRuntimeTaskAddress(task)
      const context = await port.findCloudContextForTask(sharedTask)
      const issue = context.issueId ? await port.findIssueForTask(sharedTask) : null
      return {
        project: toCloudProject(context.project),
        loop_item: issue ? toCloudLoopItem(issue) : null,
      }
    },
    bindTask(issueId, task, taskTitle) {
      return port.bindTask(issueId, toWorkspaceRuntimeTaskAddress(task), taskTitle)
    },
    unbindCloudContext(task) {
      return port.unbindCloudContext(toWorkspaceRuntimeTaskAddress(task))
    },
    async trackProjectTask(projectId, task, title, description) {
      const result = await port.trackProjectTask(
        projectId,
        toWorkspaceRuntimeTaskAddress(task),
        title,
        description
      )
      return { item: toCloudLoopItem(result.issue) }
    },
    async updateTaskTrackingTitle(task, title) {
      const issue = await port.updateTrackedTaskTitle(toWorkspaceRuntimeTaskAddress(task), title)
      return issue ? toCloudLoopItem(issue) : null
    },
  }
  cloudRuntimeApis.set(port, api)
  return api
}

function localProjectTaskRuntimeApi(
  services: WorkbenchServices
): ProjectTaskRuntimeApi | undefined {
  return services.projectSpaceApis?.local
}

function cloudProjectTaskRuntimeApi(
  services: WorkbenchServices
): ProjectTaskRuntimeApi | undefined {
  return services.workspaceRuntimePort
    ? createCloudProjectTaskRuntimeApi(services.workspaceRuntimePort)
    : undefined
}

export function projectTaskRuntimeApiForProject(
  services: WorkbenchServices | undefined,
  project: Pick<CloudProject, 'project_store' | 'task_provider'>
): ProjectTaskRuntimeApi | undefined {
  if (!services) return undefined
  return project.project_store === 'local' || project.task_provider === 'dingtalk_aitable'
    ? localProjectTaskRuntimeApi(services)
    : cloudProjectTaskRuntimeApi(services)
}

export function rememberProjectTaskStore(
  address: RuntimeTaskAddress,
  projectStore: 'backend' | 'local'
) {
  const key = runtimeTaskKey(address)
  if (projectStoreByRuntimeTask.get(key) === projectStore) return false
  projectStoreByRuntimeTask.set(key, projectStore)
  return true
}

export function projectTaskTrackingApi(services: WorkbenchServices, address: RuntimeTaskAddress) {
  const projectStore = runtimeTaskProjectStore(address)
  if (projectStore === 'backend') return cloudProjectTaskRuntimeApi(services) ?? null
  if (projectStore === 'local') return localProjectTaskRuntimeApi(services) ?? null
  return services.projectSpaceApis?.defaultLocation === 'cloud'
    ? (cloudProjectTaskRuntimeApi(services) ?? null)
    : (localProjectTaskRuntimeApi(services) ?? null)
}
