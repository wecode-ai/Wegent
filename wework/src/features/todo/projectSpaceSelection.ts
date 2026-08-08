import type { CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeProjectSpaceRef, RuntimeTaskAddress } from '@/types/api'

export type ProjectSpaceApi = NonNullable<WorkbenchServices['deliveryApi']>

export interface ProjectSpaceOption {
  key: string
  project: CloudProject
  api: ProjectSpaceApi
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

export function findProjectSpaceContextForTask(
  apis: ProjectSpaceApi[],
  task: RuntimeTaskAddress
): ReturnType<ProjectSpaceApi['findCloudContextForTask']> {
  return Promise.any(apis.map(api => api.findCloudContextForTask(task)))
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
      if (!options.has(option.key)) options.set(option.key, option)
    }
  }
  return Array.from(options.values()).sort((left, right) =>
    left.project.name.localeCompare(right.project.name)
  )
}
