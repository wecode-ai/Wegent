import { isDefaultWorkItemProject, type CloudLoopItem, type CloudProject } from '@/api/deliveries'
import { canEditCollaborationIssue } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeProjectSpaceRef, RuntimeTaskAddress } from '@/types/api'

export type ProjectSpaceApi = NonNullable<WorkbenchServices['deliveryApi']>
export interface ProjectSpaceTaskContextApi {
  findCloudContextForTask(
    task: RuntimeTaskAddress
  ): Promise<{ project: CloudProject; loop_item: CloudLoopItem | null }>
}
export type LocatedProjectSpace = CloudProject & {
  location: 'local' | 'cloud'
}

export interface ProjectSpaceOption {
  key: string
  project: CloudProject
  api: ProjectSpaceApi
}

export { isDefaultWorkItemProject }

export function canEditProjectSpaceIssue(issue: {
  can_edit?: boolean
  project_store?: 'local' | 'backend'
}): boolean {
  return issue.project_store === 'local' ? true : canEditCollaborationIssue(issue)
}

export function projectStoreLocation(
  projectStore: RuntimeProjectSpaceRef['projectStore']
): 'local' | 'cloud' {
  return projectStore === 'local' ? 'local' : 'cloud'
}

export interface ProjectSpaceTaskChange {
  task: RuntimeTaskAddress
  project: RuntimeProjectSpaceRef
}

export interface ProjectSpaceTaskBindingChange extends ProjectSpaceTaskChange {
  type: 'bound' | 'unbound'
}

const projectSpaceByRuntimeTask = new Map<string, RuntimeProjectSpaceRef>()
const projectSpaceTaskContextListeners = new Set<(change: ProjectSpaceTaskChange) => void>()
const projectSpaceTaskBindingListeners = new Set<(change: ProjectSpaceTaskBindingChange) => void>()

function runtimeTaskKey(task: RuntimeTaskAddress): string {
  return `${task.deviceId}\0${task.taskId}`
}

export function rememberProjectSpaceTaskBinding(
  task: RuntimeTaskAddress,
  project: RuntimeProjectSpaceRef
): boolean {
  const key = runtimeTaskKey(task)
  if (sameProjectSpace(projectSpaceByRuntimeTask.get(key), project)) return false
  projectSpaceByRuntimeTask.set(key, project)
  return true
}

export function forgetProjectSpaceTaskBinding(
  task: RuntimeTaskAddress,
  project: RuntimeProjectSpaceRef
): boolean {
  const key = runtimeTaskKey(task)
  if (!sameProjectSpace(projectSpaceByRuntimeTask.get(key), project)) return false
  return projectSpaceByRuntimeTask.delete(key)
}

export function projectSpaceForRuntimeTask(
  task: RuntimeTaskAddress
): RuntimeProjectSpaceRef | undefined {
  return projectSpaceByRuntimeTask.get(runtimeTaskKey(task))
}

export function reconcileProjectSpaceTaskBindings(
  project: RuntimeProjectSpaceRef,
  tasks: readonly RuntimeTaskAddress[]
): boolean {
  const snapshotTaskKeys = new Set(tasks.map(runtimeTaskKey))
  let changed = false

  for (const [key, mappedProject] of projectSpaceByRuntimeTask) {
    if (!sameProjectSpace(mappedProject, project) || snapshotTaskKeys.has(key)) continue
    projectSpaceByRuntimeTask.delete(key)
    changed = true
  }

  for (const task of tasks) {
    changed = rememberProjectSpaceTaskBinding(task, project) || changed
  }

  return changed
}

export function publishProjectSpaceTaskContextChanged(change: ProjectSpaceTaskChange) {
  rememberProjectSpaceTaskBinding(change.task, change.project)
  for (const listener of projectSpaceTaskContextListeners) listener(change)
}

export function subscribeProjectSpaceTaskContextChanged(
  listener: (change: ProjectSpaceTaskChange) => void
) {
  projectSpaceTaskContextListeners.add(listener)
  return () => {
    projectSpaceTaskContextListeners.delete(listener)
  }
}

export function publishProjectSpaceTaskBindingChanged(change: ProjectSpaceTaskBindingChange) {
  if (change.type === 'unbound') {
    forgetProjectSpaceTaskBinding(change.task, change.project)
  } else {
    rememberProjectSpaceTaskBinding(change.task, change.project)
  }
  for (const listener of projectSpaceTaskBindingListeners) listener(change)
}

export function subscribeProjectSpaceTaskBindingChanged(
  listener: (change: ProjectSpaceTaskBindingChange) => void
) {
  projectSpaceTaskBindingListeners.add(listener)
  return () => {
    projectSpaceTaskBindingListeners.delete(listener)
  }
}

export async function loadDefaultWorkItemProject(
  api: ProjectSpaceApi
): Promise<CloudProject | null> {
  const response = await api.listCloudProjects()
  return response.items.find(isDefaultWorkItemProject) ?? null
}

export function projectSpaceRef(project: CloudProject): RuntimeProjectSpaceRef {
  return {
    projectStore: project.project_store,
    projectId: project.id,
  }
}

export function projectSpaceKey(ref: RuntimeProjectSpaceRef): string {
  return `${ref.projectStore}:${ref.projectId}`
}

export function projectKey(project: Pick<CloudProject, 'id' | 'project_store'>): string {
  return projectSpaceKey({
    projectStore: project.project_store,
    projectId: project.id,
  })
}

export function sameProjectSpace(
  left: RuntimeProjectSpaceRef | null | undefined,
  right: RuntimeProjectSpaceRef | null | undefined
): boolean {
  if (!left || !right) return left === right
  return left.projectStore === right.projectStore && left.projectId === right.projectId
}

export function runtimeCloudProjectId(project: CloudProject | null): string | undefined {
  return project?.project_store === 'backend' ? project.id : undefined
}

export function projectSpaceApis(
  services: WorkbenchServices | null | undefined
): ProjectSpaceApi[] {
  if (!services) return []
  const candidates = [
    services.projectSpaceApis?.local,
    services.projectSpaceApis?.cloud,
    services.deliveryApi,
  ]
  return candidates.filter(
    (api, index): api is ProjectSpaceApi => Boolean(api) && candidates.indexOf(api) === index
  )
}

/** Robot execution is supported for the local Issue store and issue-based
 * providers (GitHub/GitLab). Record providers such as DingTalk AI Table keep
 * their data outside the Wegent execution model for now. */
export function projectSupportsRobotAutomation(project: CloudProject): boolean {
  return ['local', 'github', 'gitlab'].includes(project.task_provider)
}

export async function findProjectSpaceContextForTask(
  apis: ProjectSpaceTaskContextApi[],
  task: RuntimeTaskAddress,
  timeoutMs = 5_000
): ReturnType<ProjectSpaceTaskContextApi['findCloudContextForTask']> {
  type TaskContext = Awaited<ReturnType<ProjectSpaceTaskContextApi['findCloudContextForTask']>>
  const results: Array<PromiseSettledResult<TaskContext> | undefined> = new Array(apis.length)
  let resolveUserContext: ((context: TaskContext) => void) | undefined
  const userContextFound = new Promise<TaskContext>(resolve => {
    resolveUserContext = resolve
  })
  const requests = apis.map((api, index) =>
    api.findCloudContextForTask(task).then(
      value => {
        results[index] = { status: 'fulfilled', value }
        if (!isDefaultWorkItemProject(value.project)) resolveUserContext?.(value)
      },
      reason => {
        results[index] = { status: 'rejected', reason }
      }
    )
  )
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    Promise.all(requests).then(() => ({ kind: 'settled' as const })),
    userContextFound.then(context => ({ kind: 'user-context' as const, context })),
    new Promise<void>(resolve => {
      timeoutId = setTimeout(resolve, timeoutMs)
    }).then(() => ({ kind: 'timeout' as const })),
  ])
  if (timeoutId !== undefined) clearTimeout(timeoutId)
  if (outcome.kind === 'user-context') return outcome.context
  const settledResults = results.filter(result => result !== undefined)
  const contexts = settledResults.flatMap(result =>
    result.status === 'fulfilled' ? [result.value] : []
  )
  const userContext = contexts.find(context => !isDefaultWorkItemProject(context.project))
  if (userContext) return userContext
  if (contexts[0]) return contexts[0]
  const errors = settledResults.flatMap(result =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (settledResults.length < apis.length) {
    errors.push(new Error(`Project-space context lookup timed out after ${timeoutMs}ms`))
  }
  throw new AggregateError(errors, 'Task is not linked to a project space')
}

export async function loadProjectSpaceOptions(
  apis: ProjectSpaceApi[]
): Promise<ProjectSpaceOption[]> {
  const results = await Promise.allSettled(
    apis.map(async api => {
      const projects = await api.listCloudProjects()
      return projects.items.map(project => ({
        key: projectSpaceKey(projectSpaceRef(project)),
        project,
        api,
      }))
    })
  )
  const options = new Map<string, ProjectSpaceOption>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const option of result.value) {
      if (isDefaultWorkItemProject(option.project)) continue
      if (!options.has(option.key)) options.set(option.key, option)
    }
  }
  return Array.from(options.values()).sort((left, right) =>
    left.project.name.localeCompare(right.project.name)
  )
}
