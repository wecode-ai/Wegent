// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationGroupCreateInput,
  CollaborationGroupUpdateInput,
} from '../ports/SharedWorkspaceApi'
import type {
  CollaborationExecutionEnvironment,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspaceRole,
  CollaborationUser,
} from '../types'
import type { PlatformMutationOwner } from './collaborationPlatformSource'
import {
  type CollaborationPlatformState,
  updateCurrentWorkspace,
} from './platformNavigationCollections'
export function createCollaborationPlatformMutations(owner: PlatformMutationOwner) {
  const api = owner.api,
    navigation = owner.navigation
  const registerProject = owner.registerProject,
    refreshPendingNavigation = owner.refreshPendingNavigation
  return {
    async archiveProject(project: CollaborationProject) {
      owner.location()
      const setState = owner.publish

      await api.projects.archive(project.id, project.version)
      navigation.cache = {
        workspaces: navigation.cache.workspaces.map(workspace =>
          workspace.id === project.workspace_id
            ? {
                ...workspace,
                project_count: Math.max(0, workspace.project_count - 1),
              }
            : workspace
        ),
        projects: navigation.cache.projects.filter(item => item.id !== project.id),
      }
      setState(current => ({
        ...current,
        projects: current.projects.filter(item => item.id !== project.id),
        navigationProjects: current.navigationProjects.filter(item => item.id !== project.id),
        workspace:
          current.workspace && current.workspace.id === project.workspace_id
            ? {
                ...current.workspace,
                project_count: Math.max(0, current.workspace.project_count - 1),
              }
            : current.workspace,
        workspaces: current.workspaces.map(workspace =>
          workspace.id === project.workspace_id
            ? {
                ...workspace,
                project_count: Math.max(0, workspace.project_count - 1),
              }
            : workspace
        ),
      }))
      refreshPendingNavigation()
    },
    async createWorkspace(input: { name: string; description?: string }) {
      owner.location()
      const setState = owner.publish

      if (!api.workspaces) throw new Error('Workspace API is unavailable')
      const workspace = await api.workspaces.create(input)
      navigation.cache = {
        ...navigation.cache,
        workspaces: [workspace, ...navigation.cache.workspaces],
      }
      setState(current => ({
        ...current,
        workspaces: [workspace, ...current.workspaces],
      }))
      refreshPendingNavigation()
      return workspace
    },
    async updateWorkspace(input: { version: number; name?: string; description?: string }) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId) {
        throw new Error('Workspace API is unavailable')
      }
      const workspace = await api.workspaces.update(location.workspaceId, input)
      navigation.cache = {
        ...navigation.cache,
        workspaces: navigation.cache.workspaces.map(candidate =>
          candidate.id === workspace.id ? workspace : candidate
        ),
      }
      setState(current => ({
        ...current,
        workspace,
        workspaces: current.workspaces.map(candidate =>
          candidate.id === workspace.id ? workspace : candidate
        ),
      }))
      refreshPendingNavigation()
      return workspace
    },
    async createProject(
      input: {
        name: string
        description?: string
        projectKey?: string
        taskProvider?: 'local' | 'github' | 'gitlab' | 'dingtalk_aitable'
        visibility?: 'private' | 'public'
        publicAccess?: { role: 'Viewer' }
        defaultIssueSecurity?: 'open' | 'related'
        providerConfig?: Record<string, unknown>
      },
      workspaceId?: string | null
    ) {
      const location = owner.location()
      const targetWorkspaceId = workspaceId === undefined ? location.workspaceId : workspaceId

      const project = await api.projects.create({
        ...input,
        workspaceId: targetWorkspaceId ?? undefined,
      })
      registerProject(project)
      if (
        project.workspace_id &&
        !navigation.cache.workspaces.some(workspace => workspace.id === project.workspace_id)
      )
        void owner.reload()
      return project
    },
    async searchUsers(query: string): Promise<CollaborationUser[]> {
      owner.location()
      return api.members.searchUsers(query)
    },
    async transferOwnership(userId: number, version: number) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces?.transferOwnership || !location.workspaceId)
        throw new Error('Ownership transfer is unavailable')
      const workspace = await api.workspaces.transferOwnership(location.workspaceId, {
        userId,
        version,
      })
      setState(current => ({
        ...current,
        ...updateCurrentWorkspace(current, () => workspace),
      }))
    },
    async addMember(userId: number, role: Exclude<CollaborationWorkspaceRole, 'Owner'>) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId) {
        throw new Error('Workspace API is unavailable')
      }
      const member = await api.workspaces.addMember(location.workspaceId, {
        userId,
        role,
      })
      setState(current => ({
        ...current,
        members: [
          ...current.members.filter(candidate => candidate.user_id !== member.user_id),
          member,
        ],
        ...updateCurrentWorkspace(current, workspace => ({
          ...workspace,
          member_count: current.members.some(candidate => candidate.user_id === member.user_id)
            ? workspace.member_count
            : workspace.member_count + 1,
        })),
      }))
      return member
    },
    async updateMember(userId: number, role: Exclude<CollaborationWorkspaceRole, 'Owner'>) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId) {
        throw new Error('Workspace API is unavailable')
      }
      const member = await api.workspaces.updateMember(location.workspaceId, userId, { role })
      setState(current => ({
        ...current,
        members: current.members.map(candidate =>
          candidate.user_id === member.user_id ? member : candidate
        ),
      }))
      return member
    },
    async removeMember(userId: number) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId) {
        throw new Error('Workspace API is unavailable')
      }
      await api.workspaces.removeMember(location.workspaceId, userId)
      setState(current => ({
        ...current,
        members: current.members.filter(candidate => candidate.user_id !== userId),
        ...updateCurrentWorkspace(current, workspace => ({
          ...workspace,
          member_count: Math.max(0, workspace.member_count - 1),
        })),
      }))
    },
    async addAgent(agent: CollaborationOwnedAgent) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId || !agent.team_id) {
        throw new Error('Agent cannot be authorized')
      }
      const added = await api.workspaces.addAgent(location.workspaceId, {
        teamId: agent.team_id,
      })
      setState(current => ({
        ...current,
        agents: [...current.agents.filter(candidate => candidate.team_id !== added.team_id), added],
        resources: {
          ...current.resources,
          agents: current.resources.agents.map(candidate =>
            candidate.team_id === added.team_id ? added : candidate
          ),
        },
        ...updateCurrentWorkspace(current, workspace => ({
          ...workspace,
          agent_count: current.agents.some(candidate => candidate.team_id === added.team_id)
            ? workspace.agent_count
            : workspace.agent_count + 1,
        })),
      }))
      return added
    },
    async removeAgent(agent: CollaborationOwnedAgent) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId || !agent.team_id) {
        throw new Error('Agent cannot be removed')
      }
      await api.workspaces.removeAgent(location.workspaceId, agent.team_id)
      setState(current => ({
        ...current,
        agents: current.agents.filter(candidate => candidate.team_id !== agent.team_id),
        resources: {
          ...current.resources,
          agents: current.resources.agents,
        },
        ...updateCurrentWorkspace(current, workspace => ({
          ...workspace,
          agent_count: Math.max(0, workspace.agent_count - 1),
        })),
      }))
    },
    async createCollaborationGroup(input: CollaborationGroupCreateInput) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId) {
        throw new Error('Workspace API is unavailable')
      }
      const group = await api.workspaces.createCollaborationGroup(location.workspaceId, input)
      setState(current => ({
        ...current,
        collaborationGroups: [...current.collaborationGroups, group],
      }))
      return group
    },
    async updateCollaborationGroup(groupId: string, input: CollaborationGroupUpdateInput) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId) {
        throw new Error('Workspace API is unavailable')
      }
      const group = await api.workspaces.updateCollaborationGroup(
        location.workspaceId,
        groupId,
        input
      )
      setState(current => ({
        ...current,
        collaborationGroups: current.collaborationGroups.map(candidate =>
          candidate.id === group.id ? group : candidate
        ),
      }))
      return group
    },
    async removeCollaborationGroup(groupId: string) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId) {
        throw new Error('Workspace API is unavailable')
      }
      await api.workspaces.removeCollaborationGroup(location.workspaceId, groupId)
      setState(current => ({
        ...current,
        collaborationGroups: current.collaborationGroups.filter(group => group.id !== groupId),
      }))
    },
    async addExecutionEnvironment(environment: CollaborationExecutionEnvironment) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId || !environment.device_id) {
        throw new Error('Execution environment cannot be authorized')
      }
      const added = await api.workspaces.addExecutionEnvironment(location.workspaceId, {
        deviceId: environment.device_id,
      })
      setState(current => ({
        ...current,
        executionEnvironments: [
          ...current.executionEnvironments.filter(
            candidate => candidate.device_id !== added.device_id
          ),
          added,
        ],
        resources: {
          ...current.resources,
          execution_environments: current.resources.execution_environments.map(candidate =>
            candidate.device_id === added.device_id ? added : candidate
          ),
        },
        ...updateCurrentWorkspace(current, workspace => ({
          ...workspace,
          execution_environment_count: current.executionEnvironments.some(
            candidate => candidate.device_id === added.device_id
          )
            ? workspace.execution_environment_count
            : workspace.execution_environment_count + 1,
        })),
      }))
      return added
    },
    async removeExecutionEnvironment(environment: CollaborationExecutionEnvironment) {
      const location = owner.location()
      const setState = (
        update: (current: CollaborationPlatformState) => CollaborationPlatformState
      ) => owner.publishWorkspace(location.workspaceId, update)

      if (!api.workspaces || !location.workspaceId || !environment.device_id) {
        throw new Error('Execution environment cannot be removed')
      }
      await api.workspaces.removeExecutionEnvironment(location.workspaceId, environment.device_id)
      setState(current => ({
        ...current,
        executionEnvironments: current.executionEnvironments.filter(
          candidate => candidate.device_id !== environment.device_id
        ),
        resources: {
          ...current.resources,
          execution_environments: current.resources.execution_environments,
        },
        ...updateCurrentWorkspace(current, workspace => ({
          ...workspace,
          execution_environment_count: Math.max(0, workspace.execution_environment_count - 1),
        })),
      }))
    },
  }
}
