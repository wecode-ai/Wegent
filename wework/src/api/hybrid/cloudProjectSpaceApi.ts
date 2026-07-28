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
  const tasks = new Map<string, CloudLoopItem>()

  function rememberProject(project: CloudProject): CloudProject {
    projects.set(project.id, project)
    return project
  }

  function rememberTasks(projectId: CloudProjectId, items: CloudLoopItem[]): void {
    for (const item of items) {
      taskProjects.set(item.id, projectId)
      tasks.set(item.id, item)
    }
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

  function requireTaskPermission(itemId: string, permission: 'view' | 'edit'): void {
    const item = tasks.get(itemId)
    if (!item) throw new Error('Task must be loaded before it can be accessed')
    if (permission === 'view' && item.can_view_detail === false) {
      throw new Error('You can only view tasks that you created in this public project')
    }
    if (permission === 'edit' && item.can_edit === false) {
      throw new Error('You can only edit tasks that you created in this public project')
    }
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
            project.provider_config?.credential_configured !== false
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
      if (isExternalProject(project)) requireTaskPermission(itemId, 'view')
      const item = isExternalProject(project)
        ? await externalIssueApi.getLoopItem(project, itemId)
        : await storeApi.getLoopItem(itemId)
      rememberTasks(project.id, [item])
      return item
    },
    async createLoopItem(projectId, data) {
      const project = requireProject(projectId)
      const item = isExternalProject(project)
        ? await externalIssueApi.createLoopItem(project, data)
        : await storeApi.createLoopItem(projectId, data)
      rememberTasks(project.id, [item])
      return item
    },
    async updateLoopItem(itemId, data) {
      const project = requireTaskProject(itemId)
      if (isExternalProject(project)) requireTaskPermission(itemId, 'edit')
      const item = isExternalProject(project)
        ? await externalIssueApi.updateLoopItem(project, itemId, data)
        : await storeApi.updateLoopItem(itemId, data)
      rememberTasks(project.id, [item])
      return item
    },
    async reorderLoopItems(projectId, data) {
      const project = requireProject(projectId)
      if (!isExternalProject(project)) {
        return storeApi.reorderLoopItems(projectId, data)
      }
      if (project.access_role === 'RestrictedAnalyst') {
        throw new Error('Public project visitors cannot reorder tasks')
      }
      const response = await externalIssueApi.listLoopItems(project)
      rememberTasks(project.id, response.items)
      return response
    },
    async listDeliveries(itemId) {
      if (isExternalProject(requireTaskProject(itemId))) requireTaskPermission(itemId, 'view')
      return isExternalProject(requireTaskProject(itemId))
        ? { items: [] }
        : storeApi.listDeliveries(itemId)
    },
    async listTaskBindings(itemId) {
      if (isExternalProject(requireTaskProject(itemId))) requireTaskPermission(itemId, 'view')
      return isExternalProject(requireTaskProject(itemId)) ? [] : storeApi.listTaskBindings(itemId)
    },
    async listLoopItemAttachments(itemId) {
      if (isExternalProject(requireTaskProject(itemId))) requireTaskPermission(itemId, 'view')
      return isExternalProject(requireTaskProject(itemId))
        ? []
        : storeApi.listLoopItemAttachments(itemId)
    },
    async listLoopItemCollaborators(itemId) {
      if (isExternalProject(requireTaskProject(itemId))) requireTaskPermission(itemId, 'view')
      return isExternalProject(requireTaskProject(itemId))
        ? []
        : storeApi.listLoopItemCollaborators(itemId)
    },
  }
}
