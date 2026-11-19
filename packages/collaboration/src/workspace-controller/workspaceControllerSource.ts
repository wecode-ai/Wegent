// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createCollaborationWorkspaceControllerCommands } from './workspaceControllerCommands'
import {
  collaborationWorkspaceControllerReducer,
  initialCollaborationWorkspaceControllerState,
} from './workspaceControllerState'
import type {
  CollaborationWorkspaceControllerCommands,
  CollaborationWorkspaceControllerOptions,
  CollaborationWorkspaceControllerState,
} from './workspaceControllerTypes'
import { defaultExternalGitBoardPageSize } from './workspaceControllerPaging'
const unavailableCollaborationWorkspaceControllerCommands: CollaborationWorkspaceControllerCommands =
  {
    loadProjects: async () => undefined,
    loadProjectCatalog: async () => undefined,
    loadMyWork: async () => undefined,
    loadProject: async () => undefined,
    loadProjectSnapshot: async () => null,
    loadMoreExternalColumn: async () => undefined,
    getIssue: async () => null,
    loadSelectedIssue: async () => null,
    markIssueRead: async () => null,
    confirmIssueRead: issue => issue,
    clearProject: () => undefined,
    clearSelectedIssue: () => undefined,
    createProject: async () => null,
    updateProject: async () => null,
    archiveProject: async () => false,
    createIssue: async () => null,
    updateIssue: async () => null,
    assignIssue: async () => null,
    archiveIssue: async () => false,
    refreshSelectedIssue: async () => undefined,
    refreshProjectAgents: async () => undefined,
    replaceProject: () => undefined,
    appendIssue: () => undefined,
    replaceIssue: () => undefined,
    replaceAttachments: () => undefined,
    replaceComments: () => undefined,
    replaceAssignments: () => undefined,
    reportError: () => undefined,
  }

export function createWorkspaceControllerSource(initial: CollaborationWorkspaceControllerOptions) {
  const api = initial.api
  const settingsProject =
    initial.initialProject &&
    api &&
    initial.loadProjectOnLocation !== false &&
    initial.location.view === 'manage' &&
    initial.initialProject.id === initial.location.projectId
      ? initial.initialProject
      : null
  let state: CollaborationWorkspaceControllerState = initial.initialProject
    ? {
        ...initialCollaborationWorkspaceControllerState,
        projects: [initial.initialProject],
        project: settingsProject,
        loading: !settingsProject,
      }
    : initialCollaborationWorkspaceControllerState
  let observation = initial
  const listeners = new Set<() => void>()
  let commandRevision = 0
  let locationRevision = 0
  let loadedProjectKeys: unknown[] | undefined
  let routeKeys: unknown[] | undefined
  let issueId: string | null | undefined
  let issueObserved = false
  let pollKeys: unknown[] | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const configuration = (options: CollaborationWorkspaceControllerOptions) => [
    options.messages.loadFailed,
    options.messages.saveFailed,
    options.messages.conflict,
    options.myWorkEnabled ?? api?.myWork !== undefined,
    options.preloadHomeSnapshots ?? true,
  ]
  let config = configuration(initial)
  const changed = (previous: unknown[] | undefined, next: unknown[]) =>
    !previous || next.some((value, index) => !Object.is(value, previous[index]))
  const createCommands = () => {
    if (!api) return unavailableCollaborationWorkspaceControllerCommands
    const revision = commandRevision
    const isCurrent = () => listeners.size > 0 && revision === commandRevision
    return createCollaborationWorkspaceControllerCommands({
      api,
      messages: observation.messages,
      myWorkEnabled: observation.myWorkEnabled ?? api.myWork !== undefined,
      preloadHomeSnapshots: observation.preloadHomeSnapshots ?? true,
      isCurrent,
      getNavigationRevision: () => locationRevision,
      dispatch(action) {
        if (!isCurrent()) return
        state = collaborationWorkspaceControllerReducer(state, action)
        listeners.forEach(listener => listener())
      },
      getProjects: () => state.projects,
      getProjectSnapshot(projectId) {
        const items = state.projectItems[projectId]
        const members = state.projectMembers[projectId]
        const agents = state.projectAgents[projectId]
        const taskBindings = state.projectTaskBindings[projectId]
        return items && members && agents && taskBindings
          ? { items, members, agents, taskBindings }
          : null
      },
      getSelectedIssue: () => state.selectedIssue,
      getExternalBoardState: () => state,
      getExternalBoardOptions: () =>
        observation.externalBoard ?? {
          parentId: null,
          pageSize: defaultExternalGitBoardPageSize,
          eager: true,
        },
      notify(message, kind) {
        if (isCurrent()) observation.notify?.(message, kind)
      },
    })
  }
  let commands = createCommands()
  const startLocation = () => {
    const currentCommands = commands
    const revision = ++locationRevision
    const isCurrent = () => listeners.size > 0 && revision === locationRevision
    const { location } = observation
    const myWorkEnabled = observation.myWorkEnabled ?? api?.myWork !== undefined
    const loadProject = observation.loadProjectOnLocation ?? true
    if (location.projectId) {
      const projectId = location.projectId
      const scope = [
        currentCommands,
        loadProject,
        location.view !== 'manage',
        projectId,
        location.rootView,
        myWorkEnabled,
      ]
      void (async () => {
        if (location.issueId) {
          const issue = await currentCommands.loadSelectedIssue(location.issueId)
          if (!isCurrent()) return
          if (issue?.invited_only) {
            state = { ...state, loading: false }
            listeners.forEach(listener => listener())
            return
          }
        }
        if (!changed(loadedProjectKeys, scope) && (!loadProject || state.project?.id === projectId))
          return
        if (loadProject)
          await currentCommands.loadProject(projectId, true, {
            isCurrent,
            loadSnapshot: location.view !== 'manage',
          })
        else await currentCommands.loadProjectCatalog({ isCurrent })
        if (isCurrent()) loadedProjectKeys = scope
      })()
      if (myWorkEnabled && location.rootView === 'my-work') void currentCommands.loadMyWork()
    } else {
      currentCommands.clearProject()
      if (myWorkEnabled && location.rootView === 'my-work') void currentCommands.loadMyWork()
      else void currentCommands.loadProjects()
    }
  }
  return {
    api,
    getSnapshot: () => state,
    get commands() {
      return commands
    },
    subscribe(next: CollaborationWorkspaceControllerOptions, listener: () => void) {
      listeners.add(listener)
      observation = {
        ...next,
        location: { ...next.location },
        externalBoard: next.externalBoard ? { ...next.externalBoard } : undefined,
      }
      const nextConfig = configuration(next)
      if (changed(config, nextConfig)) {
        config = nextConfig
        commandRevision++
        commands = createCommands()
        routeKeys = undefined
        issueObserved = false
        pollKeys = undefined
      }
      if (api) {
        const route = observation.location
        const loadProject = observation.loadProjectOnLocation ?? true
        const loadSnapshot = loadProject && route.view !== 'manage'
        const nextRouteKeys = [
          route.projectId,
          route.issueId,
          route.rootView,
          loadProject,
          loadSnapshot,
        ]
        if (changed(routeKeys, nextRouteKeys)) {
          routeKeys = nextRouteKeys
          startLocation()
        }
        const interval = observation.pollIntervalMs ?? 15_000
        const nextPollKeys = [
          route.projectId,
          route.view !== 'manage',
          interval,
          state.selectedIssue?.invited_only,
        ]
        if (changed(pollKeys, nextPollKeys)) {
          pollKeys = nextPollKeys
          if (timer !== undefined) clearInterval(timer)
          timer = undefined
          if (
            route.projectId &&
            route.view !== 'manage' &&
            interval > 0 &&
            !state.selectedIssue?.invited_only
          ) {
            const projectId = route.projectId
            const currentCommands = commands
            timer = setInterval(() => {
              const revision = locationRevision
              void currentCommands.loadProject(projectId, false, {
                isCurrent: () => listeners.size > 0 && revision === locationRevision,
              })
            }, interval)
          }
        }
        if (!issueObserved || issueId !== route.issueId) {
          issueObserved = true
          issueId = route.issueId
          if (issueId && !route.projectId) void commands.loadSelectedIssue(issueId)
          else if (!issueId) commands.clearSelectedIssue()
        }
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          locationRevision++
          commandRevision++
          if (timer !== undefined) clearInterval(timer)
          timer = undefined
          routeKeys = undefined
          pollKeys = undefined
          issueObserved = false
          commands = createCommands()
        })
      }
    },
  }
}
