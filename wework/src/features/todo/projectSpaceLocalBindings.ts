import {
  PROJECT_SPACE_LOCAL_BINDINGS_CHANGED_EVENT,
  type CloudProject,
  type CloudProjectLocalBinding,
} from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'

export type ProjectSpaceBindingApi = NonNullable<WorkbenchServices['deliveryApi']>

export interface ProjectSpaceBindingOption {
  key: string
  project: CloudProject
  api: ProjectSpaceBindingApi
  binding: CloudProjectLocalBinding | null
}

const AUTO_JOIN_PROJECT_SPACE_STORAGE_PREFIX = 'wework.project-space-auto-join.v1'

function autoJoinStorageKey(localProjectId: number, deviceId?: string | null): string {
  return `${AUTO_JOIN_PROJECT_SPACE_STORAGE_PREFIX}:${deviceId || 'all'}:${localProjectId}`
}

export function readCachedAutoJoinProjectSpace(
  localProjectId: number,
  deviceId?: string | null
): CloudProject | null {
  try {
    const stored = window.localStorage.getItem(autoJoinStorageKey(localProjectId, deviceId))
    return stored ? (JSON.parse(stored) as CloudProject) : null
  } catch {
    return null
  }
}

export function cacheAutoJoinProjectSpace(
  localProjectId: number,
  deviceId: string | null | undefined,
  project: CloudProject | null
): void {
  try {
    const key = autoJoinStorageKey(localProjectId, deviceId)
    if (project) {
      window.localStorage.setItem(key, JSON.stringify(project))
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Persistence is an optimization; the server binding remains authoritative.
  }
}

export function projectSpaceBindingApis(
  services: WorkbenchServices | null | undefined
): ProjectSpaceBindingApi[] {
  if (!services) return []
  const candidates = [
    services.projectSpaceApis?.local,
    services.projectSpaceApis?.cloud,
    services.deliveryApi,
  ]
  return candidates.filter(
    (api, index): api is ProjectSpaceBindingApi => Boolean(api) && candidates.indexOf(api) === index
  )
}

export function findProjectSpaceContextForTask(
  apis: ProjectSpaceBindingApi[],
  task: RuntimeTaskAddress
): ReturnType<ProjectSpaceBindingApi['findCloudContextForTask']> {
  return Promise.any(apis.map(api => api.findCloudContextForTask(task)))
}

function matchingBinding(
  bindings: CloudProjectLocalBinding[],
  localProjectId: number,
  deviceId?: string
): CloudProjectLocalBinding | null {
  return (
    bindings.find(
      binding =>
        binding.local_project_id === localProjectId && binding.device_id === (deviceId ?? null)
    ) ??
    bindings.find(
      binding => binding.local_project_id === localProjectId && binding.device_id === null
    ) ??
    null
  )
}

function optionKey(project: CloudProject): string {
  return `${project.project_store}:${project.id}`
}

export async function loadProjectSpaceBindingOptions(
  apis: ProjectSpaceBindingApi[],
  localProjectId: number,
  deviceId?: string
): Promise<ProjectSpaceBindingOption[]> {
  const results = await Promise.allSettled(
    apis.map(async api => {
      const projects = await api.listCloudProjects()
      return Promise.all(
        projects.items.map(async project => ({
          key: optionKey(project),
          project,
          api,
          binding: matchingBinding(
            await api.listLocalBindings(project.id),
            localProjectId,
            deviceId
          ),
        }))
      )
    })
  )
  const candidates = results.flatMap(result => (result.status === 'fulfilled' ? result.value : []))
  const options = new Map<string, ProjectSpaceBindingOption>()
  for (const candidate of candidates) {
    const existing = options.get(candidate.key)
    if (!existing || (!existing.binding?.is_default && candidate.binding?.is_default)) {
      options.set(candidate.key, candidate)
    }
  }
  return Array.from(options.values()).sort((left, right) =>
    left.project.name.localeCompare(right.project.name)
  )
}

export async function saveAutoJoinProjectSpace(
  options: ProjectSpaceBindingOption[],
  selectedKey: string | null,
  localProjectId: number,
  deviceId?: string
): Promise<void> {
  const selected = selectedKey ? options.find(option => option.key === selectedKey) : null
  if (selectedKey && !selected) throw new Error('Selected project space is unavailable')

  if (selected) {
    if (selected.binding) {
      if (!selected.binding.is_default) {
        await selected.api.updateLocalBinding(selected.project.id, selected.binding.id, {
          is_default: true,
        })
      }
    } else {
      await selected.api.addLocalBinding(selected.project.id, {
        local_project_id: localProjectId,
        device_id: deviceId,
        is_default: true,
      })
    }
  }

  await Promise.all(
    options
      .filter(option => option.key !== selectedKey && option.binding?.is_default)
      .map(option =>
        option.api.updateLocalBinding(option.project.id, option.binding!.id, {
          is_default: false,
        })
      )
  )
  cacheAutoJoinProjectSpace(localProjectId, deviceId, selected?.project ?? null)
  window.dispatchEvent(new Event(PROJECT_SPACE_LOCAL_BINDINGS_CHANGED_EVENT))
}
