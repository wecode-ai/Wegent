import { isDefaultWorkItemProject, type CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeProjectSpaceRef, RuntimeTaskAddress } from '@/types/api'

export type ProjectSpaceApi = NonNullable<WorkbenchServices['deliveryApi']>
export type LocatedProjectSpace = CloudProject & {
  location: 'local' | 'cloud'
}

export interface ProjectSpaceOption {
  key: string
  project: CloudProject
  api: ProjectSpaceApi
}

export { isDefaultWorkItemProject }

export function projectStoreLocation(
  projectStore: RuntimeProjectSpaceRef['projectStore']
): 'local' | 'cloud' {
  return projectStore === 'local' ? 'local' : 'cloud'
}

const projectSpaceTaskContextListeners = new Set<(task: RuntimeTaskAddress) => void>()
const projectSpaceTaskBindingListeners = new Set<(task: RuntimeTaskAddress) => void>()

export function publishProjectSpaceTaskContextChanged(task: RuntimeTaskAddress) {
  for (const listener of projectSpaceTaskContextListeners) listener(task)
}

export function subscribeProjectSpaceTaskContextChanged(
  listener: (task: RuntimeTaskAddress) => void
) {
  projectSpaceTaskContextListeners.add(listener)
  return () => {
    projectSpaceTaskContextListeners.delete(listener)
  }
}

export function publishProjectSpaceTaskBindingChanged(task: RuntimeTaskAddress) {
  for (const listener of projectSpaceTaskBindingListeners) listener(task)
}

export function subscribeProjectSpaceTaskBindingChanged(
  listener: (task: RuntimeTaskAddress) => void
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
  apis: ProjectSpaceApi[],
  task: RuntimeTaskAddress,
  timeoutMs = 5_000
): ReturnType<ProjectSpaceApi['findCloudContextForTask']> {
  type TaskContext = Awaited<ReturnType<ProjectSpaceApi['findCloudContextForTask']>>
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
