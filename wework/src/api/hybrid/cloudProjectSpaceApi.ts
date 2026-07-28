import type {
  CloudLoopItem,
  CloudProject,
  CloudProjectId,
  createDeliveryApi,
} from '@/api/deliveries'
import type { ExternalIssueApi } from '@/features/workbench/workbenchServices'

type DeliveryApi = ReturnType<typeof createDeliveryApi>

function isExternalProject(project: CloudProject): boolean {
  return project.task_provider === 'github' || project.task_provider === 'gitlab'
}

export function createCloudProjectSpaceApi(
  storeApi: DeliveryApi,
  externalIssueApi: ExternalIssueApi
): DeliveryApi {
  const projects = new Map<CloudProjectId, CloudProject>()
  const taskProjects = new Map<string, CloudProjectId>()

  function rememberProject(project: CloudProject): CloudProject {
    projects.set(project.id, project)
    return project
  }

  function rememberTasks(projectId: CloudProjectId, items: CloudLoopItem[]): void {
    for (const item of items) taskProjects.set(item.id, projectId)
  }

  function requireProject(projectId: CloudProjectId | number): CloudProject {
    const project = projects.get(String(projectId))
    if (!project) throw new Error('Project space must be loaded before its tasks')
    return project
  }

  function requireTaskProject(itemId: string): CloudProject {
    const projectId = taskProjects.get(itemId)
    if (!projectId) throw new Error('Task project must be loaded before the task')
    return requireProject(projectId)
  }

  return {
    ...storeApi,
    async listCloudProjects() {
      const response = await storeApi.listCloudProjects()
      await Promise.all(
        response.items.map(async project => {
          rememberProject(project)
          if (
            isExternalProject(project) &&
            project.provider_config.credential_configured !== false
          ) {
            let credential
            try {
              credential = await storeApi.getCloudProjectProviderCredential(project.id)
            } catch {
              return
            }
            try {
              await externalIssueApi.configureProject(project, credential.token)
            } catch {
              return
            }
          }
        })
      )
      return response
    },
    async createCloudProject(data) {
      const { token, ...providerConfig } = data.provider_config ?? {}
      const storedProject = await storeApi.createCloudProject({
        ...data,
        provider_config: data.provider_config,
      })
      const project = rememberProject({
        ...storedProject,
        project_store: 'backend',
        task_provider: data.task_provider ?? 'local',
        provider_config: providerConfig,
      })
      if (isExternalProject(project)) {
        await externalIssueApi.configureProject(project, token)
      }
      return project
    },
    async updateCloudProject(projectId, data) {
      const current = requireProject(projectId)
      const updated = await storeApi.updateCloudProject(projectId, data)
      const project = rememberProject({
        ...updated,
        project_store: current.project_store,
        task_provider: current.task_provider,
        provider_config: updated.provider_config ?? current.provider_config,
      })
      if (isExternalProject(project)) {
        const credential = await storeApi.getCloudProjectProviderCredential(project.id)
        await externalIssueApi.configureProject(project, credential.token)
      }
      return project
    },
    async listLoopItems(projectId) {
      const project = requireProject(projectId)
      const response = isExternalProject(project)
        ? await externalIssueApi.listLoopItems(project)
        : await storeApi.listLoopItems(projectId)
      rememberTasks(project.id, response.items)
      return response
    },
    async getLoopItem(itemId) {
      const project = requireTaskProject(itemId)
      const item = isExternalProject(project)
        ? await externalIssueApi.getLoopItem(project, itemId)
        : await storeApi.getLoopItem(itemId)
      taskProjects.set(item.id, project.id)
      return item
    },
    async createLoopItem(projectId, data) {
      const project = requireProject(projectId)
      const item = isExternalProject(project)
        ? await externalIssueApi.createLoopItem(project, data)
        : await storeApi.createLoopItem(projectId, data)
      taskProjects.set(item.id, project.id)
      return item
    },
    async updateLoopItem(itemId, data) {
      const project = requireTaskProject(itemId)
      const item = isExternalProject(project)
        ? await externalIssueApi.updateLoopItem(project, itemId, data)
        : await storeApi.updateLoopItem(itemId, data)
      taskProjects.set(item.id, project.id)
      return item
    },
    async reorderLoopItems(projectId, data) {
      const project = requireProject(projectId)
      if (!isExternalProject(project)) {
        return storeApi.reorderLoopItems(projectId, data)
      }
      const response = await externalIssueApi.listLoopItems(project)
      rememberTasks(project.id, response.items)
      return response
    },
    async listDeliveries(itemId) {
      return isExternalProject(requireTaskProject(itemId))
        ? { items: [] }
        : storeApi.listDeliveries(itemId)
    },
    async listTaskBindings(itemId) {
      return isExternalProject(requireTaskProject(itemId)) ? [] : storeApi.listTaskBindings(itemId)
    },
    async listLoopItemAttachments(itemId) {
      return isExternalProject(requireTaskProject(itemId))
        ? []
        : storeApi.listLoopItemAttachments(itemId)
    },
    async listLoopItemCollaborators(itemId) {
      return isExternalProject(requireTaskProject(itemId))
        ? []
        : storeApi.listLoopItemCollaborators(itemId)
    },
  }
}
