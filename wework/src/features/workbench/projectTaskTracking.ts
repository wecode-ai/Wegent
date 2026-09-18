import type { WeworkWorkspaceRuntimePort } from '@wegent/collaboration'
import type { CloudLoopItem, CloudProject, TaskExecutionStatus } from '@/api/deliveries'
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
  bindTask(
    issueId: string,
    task: RuntimeTaskAddress,
    taskTitle?: string | null,
    workflowNodeId?: string | null
  ): Promise<void>
  unbindCloudContext(task: RuntimeTaskAddress): Promise<void>
  trackProjectTask(
    projectId: string,
    task: RuntimeTaskAddress,
    title: string,
    description: string
  ): Promise<{ item: CloudLoopItem }>
  updateTaskTrackingStatus(
    task: RuntimeTaskAddress,
    executionStatus: TaskExecutionStatus
  ): Promise<CloudLoopItem | null>
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

export function createCloudProjectTaskRuntimeApi(
  port: WeworkWorkspaceRuntimePort
): ProjectTaskRuntimeApi {
  const existing = cloudRuntimeApis.get(port)
  if (existing) return existing
  const api: ProjectTaskRuntimeApi = {
    async findCloudContextForTask(task) {
      const context = await port.findCloudContextForTask(task)
      const issue = context.issueId ? await port.findIssueForTask(task) : null
      return {
        project: toCloudProject(context.project),
        loop_item: issue ? toCloudLoopItem(issue) : null,
      }
    },
    bindTask(issueId, task, taskTitle, workflowNodeId) {
      return port.bindTask(issueId, task, taskTitle, workflowNodeId)
    },
    unbindCloudContext(task) {
      return port.unbindCloudContext(task)
    },
    async trackProjectTask(projectId, task, title, description) {
      const result = await port.trackProjectTask(projectId, task, title, description)
      return { item: toCloudLoopItem(result.issue) }
    },
    async updateTaskTrackingStatus(task, executionStatus) {
      const issue = await port.updateTrackedTaskStatus(task, executionStatus)
      return issue ? toCloudLoopItem(issue) : null
    },
    async updateTaskTrackingTitle(task, title) {
      const issue = await port.updateTrackedTaskTitle(task, title)
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
