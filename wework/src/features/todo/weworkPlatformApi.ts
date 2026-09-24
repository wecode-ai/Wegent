import type { CollaborationExecutionEnvironment, SharedWorkspaceApi } from '@wegent/collaboration'
import { isDefaultWorkItemProject, type CloudProject } from '@/api/deliveries'
import { ApiError } from '@/api/http'
import type {
  ProjectSpaceApis,
  ProjectSpaceDetailServices,
} from '@/features/workbench/workbenchServices'
import { createLocalWorkspaceApi, LOCAL_WORKSPACE_ID } from './localWorkspaceApi'

function executionEnvironmentIdentity(environment: CollaborationExecutionEnvironment): string {
  return environment.device_key?.trim() || `device:${environment.device_id ?? environment.id}`
}

export function mergeExecutionEnvironmentResources(
  localEnvironments: CollaborationExecutionEnvironment[],
  cloudEnvironments: CollaborationExecutionEnvironment[]
): CollaborationExecutionEnvironment[] {
  const currentLocalDeviceKeys = new Set(
    localEnvironments
      .filter(environment => environment.kind === 'local_device')
      .map(executionEnvironmentIdentity)
  )
  const seen = new Set<string>()
  return cloudEnvironments.flatMap(environment => {
    const identity = executionEnvironmentIdentity(environment)
    if (seen.has(identity)) return []
    seen.add(identity)
    return [
      currentLocalDeviceKeys.has(identity)
        ? { ...environment, is_current_device: true }
        : environment,
    ]
  })
}

export function withoutDefaultWorkItemProject(api: SharedWorkspaceApi): SharedWorkspaceApi {
  return {
    ...api,
    projects: {
      ...api.projects,
      async list(workspaceId) {
        return (await api.projects.list(workspaceId)).filter(
          project => !isDefaultWorkItemProject(project as CloudProject)
        )
      },
    },
  }
}

export function createWeworkPlatformApi(
  cloudApi: SharedWorkspaceApi | undefined,
  localDeliveryApi: ProjectSpaceApis['local'] | undefined,
  userId: number,
  userName: string,
  userEmail: string | null,
  localDetailServices?: ProjectSpaceDetailServices,
  locale: 'zh-CN' | 'en' = 'zh-CN'
): SharedWorkspaceApi | null {
  const localWorkspaceApi = createLocalWorkspaceApi(
    localDeliveryApi,
    userId,
    userName,
    userEmail,
    localDetailServices,
    locale
  )
  if (!localWorkspaceApi) return cloudApi ? withoutDefaultWorkItemProject(cloudApi) : null
  const localApi = localWorkspaceApi
  if (!cloudApi?.workspaces) return withoutDefaultWorkItemProject(localApi)

  const isLocalWorkspace = (workspaceId: string | undefined) => workspaceId === LOCAL_WORKSPACE_ID
  const localProject = async (projectId: string) => {
    const projects = await localApi.projects.list()
    return projects.find(project => String(project.id) === projectId)
  }
  const projectLocation = async (projectId: string) =>
    (await localProject(projectId)) ? 'local' : 'cloud'
  const projectAutomations = async (projectId: string) => {
    const target = (await projectLocation(projectId)) === 'local' ? localApi : cloudApi
    if (!target.automations) {
      throw new Error('Automation API is unavailable')
    }
    return target.automations
  }
  const localIssue = async (issueId: string) => {
    try {
      return await localApi.issues.get(issueId)
    } catch (error) {
      if (
        (error instanceof ApiError && error.status === 404) ||
        (error instanceof Error && error.message === 'Local task not found')
      ) {
        return undefined
      }
      throw error
    }
  }
  const issueLocation = async (issueId: string) => ((await localIssue(issueId)) ? 'local' : 'cloud')

  return withoutDefaultWorkItemProject({
    ...cloudApi,
    workspaces: {
      ...cloudApi.workspaces,
      async list() {
        const localWorkspace = await localApi.workspaces!.get(LOCAL_WORKSPACE_ID)
        try {
          return [localWorkspace, ...(await cloudApi.workspaces!.list())]
        } catch {
          return [localWorkspace]
        }
      },
      get(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.get(workspaceId)
          : cloudApi.workspaces!.get(workspaceId)
      },
      create: cloudApi.workspaces.create,
      update(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.update(workspaceId, input)
          : cloudApi.workspaces!.update(workspaceId, input)
      },
      archive(workspaceId, version) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.archive(workspaceId, version)
          : cloudApi.workspaces!.archive(workspaceId, version)
      },
      listMembers(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.listMembers(workspaceId)
          : cloudApi.workspaces!.listMembers(workspaceId)
      },
      addMember(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.addMember(workspaceId, input)
          : cloudApi.workspaces!.addMember(workspaceId, input)
      },
      updateMember(workspaceId, memberUserId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.updateMember(workspaceId, memberUserId, input)
          : cloudApi.workspaces!.updateMember(workspaceId, memberUserId, input)
      },
      removeMember(workspaceId, memberUserId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.removeMember(workspaceId, memberUserId)
          : cloudApi.workspaces!.removeMember(workspaceId, memberUserId)
      },
      listAgents(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.listAgents(workspaceId)
          : cloudApi.workspaces!.listAgents(workspaceId)
      },
      addAgent(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.addAgent(workspaceId, input)
          : cloudApi.workspaces!.addAgent(workspaceId, input)
      },
      removeAgent(workspaceId, teamId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.removeAgent(workspaceId, teamId)
          : cloudApi.workspaces!.removeAgent(workspaceId, teamId)
      },
      listCollaborationGroups(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.listCollaborationGroups(workspaceId)
          : cloudApi.workspaces!.listCollaborationGroups(workspaceId)
      },
      createCollaborationGroup(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.createCollaborationGroup(workspaceId, input)
          : cloudApi.workspaces!.createCollaborationGroup(workspaceId, input)
      },
      updateCollaborationGroup(workspaceId, groupId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.updateCollaborationGroup(workspaceId, groupId, input)
          : cloudApi.workspaces!.updateCollaborationGroup(workspaceId, groupId, input)
      },
      removeCollaborationGroup(workspaceId, groupId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.removeCollaborationGroup(workspaceId, groupId)
          : cloudApi.workspaces!.removeCollaborationGroup(workspaceId, groupId)
      },
      listExecutionEnvironments(workspaceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.listExecutionEnvironments(workspaceId)
          : cloudApi.workspaces!.listExecutionEnvironments(workspaceId)
      },
      addExecutionEnvironment(workspaceId, input) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.addExecutionEnvironment(workspaceId, input)
          : cloudApi.workspaces!.addExecutionEnvironment(workspaceId, input)
      },
      removeExecutionEnvironment(workspaceId, deviceId) {
        return isLocalWorkspace(workspaceId)
          ? localApi.workspaces!.removeExecutionEnvironment(workspaceId, deviceId)
          : cloudApi.workspaces!.removeExecutionEnvironment(workspaceId, deviceId)
      },
    },
    projects: {
      ...cloudApi.projects,
      async list(workspaceId) {
        if (isLocalWorkspace(workspaceId)) {
          return localApi.projects.list(LOCAL_WORKSPACE_ID)
        }
        if (workspaceId) {
          return cloudApi.projects.list(workspaceId)
        }
        const localProjects = await localApi.projects.list(LOCAL_WORKSPACE_ID)
        try {
          return [...localProjects, ...(await cloudApi.projects.list())]
        } catch {
          return localProjects
        }
      },
      async create(input) {
        if (isLocalWorkspace(input.workspaceId)) {
          const project = await localApi.projects.create({
            ...input,
            workspaceId: undefined,
          })
          return { ...project, workspace_id: LOCAL_WORKSPACE_ID }
        }
        return cloudApi.projects.create(input)
      },
      async get(projectId) {
        return (await localProject(projectId)) ?? cloudApi.projects.get(projectId)
      },
      async update(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.update(projectId, input)
          : cloudApi.projects.update(projectId, input)
      },
      async archive(projectId, version) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.archive(projectId, version)
          : cloudApi.projects.archive(projectId, version)
      },
      async listExecutionEnvironments(projectId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.listExecutionEnvironments(projectId)
          : cloudApi.projects.listExecutionEnvironments(projectId)
      },
      async addExecutionEnvironment(projectId, deviceId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.addExecutionEnvironment(projectId, deviceId)
          : cloudApi.projects.addExecutionEnvironment(projectId, deviceId)
      },
      async removeExecutionEnvironment(projectId, deviceId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.removeExecutionEnvironment(projectId, deviceId)
          : cloudApi.projects.removeExecutionEnvironment(projectId, deviceId)
      },
      async importMessages(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.projects.importMessages(projectId, input)
          : cloudApi.projects.importMessages(projectId, input)
      },
      async listCollaborationGroups(projectId) {
        return (await projectLocation(projectId)) === 'local'
          ? (localApi.projects.listCollaborationGroups?.(projectId) ?? [])
          : (cloudApi.projects.listCollaborationGroups?.(projectId) ?? [])
      },
      async addCollaborationGroup(projectId, groupId) {
        const target =
          (await projectLocation(projectId)) === 'local' ? localApi.projects : cloudApi.projects
        if (!target.addCollaborationGroup) {
          throw new Error('Collaboration group API is unavailable')
        }
        return target.addCollaborationGroup(projectId, groupId)
      },
      async createCollaborationGroup(projectId, input) {
        const target =
          (await projectLocation(projectId)) === 'local' ? localApi.projects : cloudApi.projects
        if (!target.createCollaborationGroup) {
          throw new Error('Collaboration group API is unavailable')
        }
        return target.createCollaborationGroup(projectId, input)
      },
      async updateCollaborationGroup(projectId, groupId, input) {
        const target =
          (await projectLocation(projectId)) === 'local' ? localApi.projects : cloudApi.projects
        if (!target.updateCollaborationGroup) {
          throw new Error('Collaboration group API is unavailable')
        }
        return target.updateCollaborationGroup(projectId, groupId, input)
      },
      async removeCollaborationGroup(projectId, groupId) {
        const target =
          (await projectLocation(projectId)) === 'local' ? localApi.projects : cloudApi.projects
        if (!target.removeCollaborationGroup) {
          throw new Error('Collaboration group API is unavailable')
        }
        return target.removeCollaborationGroup(projectId, groupId)
      },
    },
    members: {
      ...cloudApi.members,
      list(projectId) {
        return projectLocation(projectId).then(location =>
          location === 'local' ? localApi.members.list(projectId) : cloudApi.members.list(projectId)
        )
      },
      searchUsers(query) {
        return cloudApi.members.searchUsers(query)
      },
      async add(projectId, memberUserId, role) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.members.add(projectId, memberUserId, role)
          : cloudApi.members.add(projectId, memberUserId, role)
      },
      async update(projectId, memberUserId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.members.update(projectId, memberUserId, input)
          : cloudApi.members.update(projectId, memberUserId, input)
      },
      async remove(projectId, memberUserId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.members.remove(projectId, memberUserId)
          : cloudApi.members.remove(projectId, memberUserId)
      },
    },
    agents: {
      ...cloudApi.agents,
      async list(projectId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.agents.list(projectId)
          : cloudApi.agents.list(projectId)
      },
      async create(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.agents.create(projectId, input)
          : cloudApi.agents.create(projectId, input)
      },
      async update(projectId, agentId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.agents.update(projectId, agentId, input)
          : cloudApi.agents.update(projectId, agentId, input)
      },
    },
    automations: {
      async list(projectId) {
        return (await projectAutomations(projectId)).list(projectId)
      },
      async create(projectId, input) {
        return (await projectAutomations(projectId)).create(projectId, input)
      },
      async migrateWorkflow(projectId, input) {
        return (await projectAutomations(projectId)).migrateWorkflow(projectId, input)
      },
      async update(projectId, automationId, input) {
        return (await projectAutomations(projectId)).update(projectId, automationId, input)
      },
      async remove(projectId, automationId) {
        return (await projectAutomations(projectId)).remove(projectId, automationId)
      },
      async runNow(projectId, automationId) {
        return (await projectAutomations(projectId)).runNow(projectId, automationId)
      },
      async listRuns(projectId, automationId) {
        return (await projectAutomations(projectId)).listRuns(projectId, automationId)
      },
      async cancelRun(projectId, runId) {
        return (await projectAutomations(projectId)).cancelRun(projectId, runId)
      },
      async retryRun(projectId, runId) {
        return (await projectAutomations(projectId)).retryRun(projectId, runId)
      },
    },
    issues: {
      async list(projectId, filters) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.list(projectId, filters)
          : cloudApi.issues.list(projectId, filters)
      },
      async listPage(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.listPage(projectId, input)
          : cloudApi.issues.listPage(projectId, input)
      },
      async getBoardSnapshot(projectId) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.getBoardSnapshot(projectId)
          : cloudApi.issues.getBoardSnapshot(projectId)
      },
      async get(issueId) {
        return (await localIssue(issueId)) ?? cloudApi.issues.get(issueId)
      },
      async create(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.create(projectId, input)
          : cloudApi.issues.create(projectId, input)
      },
      async update(issueId, input) {
        return (await issueLocation(issueId)) === 'local'
          ? localApi.issues.update(issueId, input)
          : cloudApi.issues.update(issueId, input)
      },
      async assign(projectId, issueId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.assign(projectId, issueId, input)
          : cloudApi.issues.assign(projectId, issueId, input)
      },
      async approveRun(projectId, issueId, version) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.approveRun(projectId, issueId, version)
          : cloudApi.issues.approveRun(projectId, issueId, version)
      },
      async rejectRun(projectId, issueId, version, reason) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.rejectRun(projectId, issueId, version, reason)
          : cloudApi.issues.rejectRun(projectId, issueId, version, reason)
      },
      async archive(issueId) {
        return (await issueLocation(issueId)) === 'local'
          ? localApi.issues.archive(issueId)
          : cloudApi.issues.archive(issueId)
      },
      async reorder(projectId, input) {
        return (await projectLocation(projectId)) === 'local'
          ? localApi.issues.reorder(projectId, input)
          : cloudApi.issues.reorder(projectId, input)
      },
      async markRead(issueId) {
        return (await issueLocation(issueId)) === 'local'
          ? localApi.issues.markRead(issueId)
          : cloudApi.issues.markRead(issueId)
      },
    },
    resources: {
      async list() {
        const localResources = localApi.resources
          ? await localApi.resources.list()
          : { agents: [], execution_environments: [] }
        if (!cloudApi.resources) return localResources
        try {
          const cloudResources = await cloudApi.resources.list()
          return {
            agents: [
              ...localResources.agents.map(agent => ({ ...agent, location: 'local' as const })),
              ...cloudResources.agents.map(agent => ({ ...agent, location: 'cloud' as const })),
            ],
            execution_environments: mergeExecutionEnvironmentResources(
              localResources.execution_environments,
              cloudResources.execution_environments
            ),
          }
        } catch {
          return localResources
        }
      },
      async removeAgent(agent) {
        const target =
          (agent.location ?? 'cloud') === 'local' ? localApi.resources : cloudApi.resources
        if (!target?.removeAgent) {
          throw new Error('Agent deletion is unavailable')
        }
        await target.removeAgent(agent)
      },
    },
  })
}
