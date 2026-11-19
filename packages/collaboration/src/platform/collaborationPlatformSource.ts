// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup, CollaborationProject, CollaborationWorkspace } from '../types'
import type { CollaborationPlatformLocation } from './types'
import type { SetStateAction } from 'react'
import { createCollaborationPlatformMutations } from './collaborationPlatformMutations'
import {
  type CollaborationPlatformState,
  emptyResources,
  loadRootMyWork,
  type RootNavigationSnapshot,
  type NavigationCollections,
  mergeByKey,
  reconcileNavigationProjects,
  mergeRootNavigationSnapshots,
  loadNavigationCollections,
} from './platformNavigationCollections'
export interface PlatformLocationObservation {
  location: CollaborationPlatformLocation
  loadFailedMessage: string
  refreshKey?: string
}
export interface PlatformNavigationCache {
  cache: { workspaces: CollaborationWorkspace[]; projects: CollaborationProject[] }
  status: 'unsettled' | 'partial' | 'complete'
  pending: object | null
}
export interface PlatformMutationOwner {
  api: SharedWorkspaceApi
  navigation: PlatformNavigationCache
  location(): CollaborationPlatformLocation
  publish(update: (current: CollaborationPlatformState) => CollaborationPlatformState): void
  publishWorkspace(
    workspaceId: string | null,
    update: (current: CollaborationPlatformState) => CollaborationPlatformState
  ): void
  registerProject(project: CollaborationProject): void
  refreshPendingNavigation(): void
  reload(): Promise<void>
}
function projectVisible(
  project: CollaborationProject,
  state: CollaborationPlatformState,
  location: CollaborationPlatformLocation
) {
  const workspaceId =
    location.workspaceId ??
    state.workspace?.id ??
    state.navigationProjects.find(project => project.id === location.projectId)?.workspace_id
  return (
    (!location.projectId && !workspaceId) ||
    location.projectId === project.id ||
    workspaceId === project.workspace_id
  )
}
export function createCollaborationPlatformSource(
  api: SharedWorkspaceApi,
  inputSources: SharedWorkspaceApi[],
  initial: PlatformLocationObservation
) {
  const sources = [...inputSources]
  let state: CollaborationPlatformState = {
    workspaces: [],
    workspace: null,
    workspaceNavigationContext: null,
    navigationProjects: [],
    navigationIncomplete: false,
    projects: [],
    projectIssues: {},
    myWork: [],
    members: [],
    agents: [],
    collaborationGroups: [],
    executionEnvironments: [],
    resources: emptyResources,
    loading: true,
    error: null,
  }
  const listeners = new Set<() => void>()
  let observation: PlatformLocationObservation | undefined
  let observedKeys: readonly unknown[] | undefined
  let observedRefresh = initial.refreshKey
  let loadRevision = 0
  const navigation: PlatformNavigationCache = {
    cache: { workspaces: [], projects: [] },
    status: 'unsettled',
    pending: null,
  }
  const setState = (value: SetStateAction<CollaborationPlatformState>) => {
    if (!listeners.size) return
    state = typeof value === 'function' ? value(state) : value
    listeners.forEach(listener => listener())
  }
  const load = async (force = false) => {
    if (!listeners.size || !observation) return
    const { location, loadFailedMessage } = observation
    const revision = ++loadRevision
    const isCurrent = () => listeners.size > 0 && revision === loadRevision
    if (force) navigation.status = 'unsettled'
    const collectNavigation = async <T>(collection: Promise<T>): Promise<T> => {
      const request = {}
      navigation.pending = request
      try {
        return await collection
      } finally {
        if (navigation.pending === request && isCurrent()) {
          navigation.pending = null
        }
      }
    }
    const rootView = location.rootView ?? 'home'
    if (
      !force &&
      !location.workspaceId &&
      !location.projectId &&
      (rootView === 'home' || rootView === 'devices' || rootView.startsWith('issues-')) &&
      navigation.status === 'complete'
    ) {
      setState(current => ({
        ...current,
        workspace: null,
        workspaceNavigationContext: null,
        projects: current.navigationProjects,
        projectIssues: {},
        members: [],
        agents: [],
        collaborationGroups: [],
        executionEnvironments: [],
        loading: false,
        error: null,
      }))
      return
    }
    let workspaceId = location.workspaceId
    let requestedProject = navigation.cache.projects.find(
      project => project.id === location.projectId
    )
    let requestedProjectAuthorized = false
    if (!workspaceId && location.projectId) {
      try {
        requestedProject = await collectNavigation(api.projects.get(location.projectId))
        requestedProjectAuthorized = true
        workspaceId = requestedProject.workspace_id ?? null
      } catch {
        workspaceId = null
      }
      if (!isCurrent()) return
    }
    if (requestedProjectAuthorized && requestedProject && !workspaceId) {
      const project = requestedProject
      navigation.cache.projects = mergeByKey(
        [[project], navigation.cache.projects],
        item => item.id
      )
      setState(current => ({
        ...current,
        workspace: null,
        workspaceNavigationContext: null,
        projects: [project],
        navigationProjects: mergeByKey([[project], current.navigationProjects], item => item.id),
        projectIssues: {},
        members: [],
        agents: [],
        collaborationGroups: [],
        executionEnvironments: [],
        loading: false,
        error: null,
      }))
      const publishStandaloneNavigation = (collections: NavigationCollections) => {
        if (!isCurrent()) return
        const projects = mergeByKey([collections.projects, [project]], item => item.id)
        navigation.cache = {
          workspaces: collections.workspaces,
          projects,
        }
        setState(current => ({
          ...current,
          workspaces: collections.workspaces,
          navigationProjects: projects,
        }))
      }
      if (!force && navigation.status === 'complete') {
        publishStandaloneNavigation({
          ...navigation.cache,
          complete: true,
          successfulLoads: 1,
        })
      } else {
        void collectNavigation(loadNavigationCollections(sources, publishStandaloneNavigation))
          .then(collections => {
            if (!isCurrent()) return
            publishStandaloneNavigation(collections)
            navigation.status = collections.complete ? 'complete' : 'partial'
            setState(current => ({
              ...current,
              navigationIncomplete: !collections.complete,
            }))
          })
          .catch(() => {
            if (isCurrent())
              setState(current => ({
                ...current,
                navigationIncomplete: true,
              }))
          })
      }
      return
    }
    if (!api.workspaces) {
      if (!isCurrent()) return
      setState(current => ({
        ...current,
        loading: false,
        error: loadFailedMessage,
      }))
      return
    }
    setState(current => ({
      ...current,
      workspace: workspaceId ? current.workspace : null,
      workspaceNavigationContext: workspaceId ? current.workspaceNavigationContext : null,
      loading: workspaceId
        ? current.workspace?.id !== workspaceId
        : navigation.status !== 'complete',
      error: null,
    }))
    if (!workspaceId) {
      const snapshots = sources.map<RootNavigationSnapshot>(() => ({
        workspaces: [],
        projects: [],
        myWork: [],
        collaborationGroups: [],
        resources: emptyResources,
      }))
      let successfulNavigationLoads = 0
      let primaryNavigationSettled = false
      let navigationComplete = false
      const publish = () => {
        if (!isCurrent()) return
        const snapshot = mergeRootNavigationSnapshots(snapshots)
        const navigationProjects = primaryNavigationSettled
          ? reconcileNavigationProjects(snapshot.projects, navigation.cache.projects)
          : undefined
        if (primaryNavigationSettled) {
          navigation.cache = {
            workspaces: snapshot.workspaces,
            projects: navigationProjects!,
          }
        }
        setState(current => ({
          ...current,
          workspaces: primaryNavigationSettled
            ? snapshot.workspaces
            : mergeByKey([current.workspaces, snapshot.workspaces], workspace => workspace.id),
          workspace: null,
          workspaceNavigationContext: null,
          navigationIncomplete: primaryNavigationSettled && !navigationComplete,
          navigationProjects:
            navigationProjects ??
            mergeByKey([current.navigationProjects, snapshot.projects], project => project.id),
          projects:
            navigationProjects ??
            mergeByKey([current.navigationProjects, snapshot.projects], project => project.id),
          projectIssues: {},
          myWork: snapshot.myWork,
          members: [],
          agents: [],
          collaborationGroups: snapshot.collaborationGroups,
          executionEnvironments: [],
          resources: snapshot.resources,
          loading: false,
          error: null,
        }))
      }
      const updateSnapshot = (index: number, update: Partial<RootNavigationSnapshot>) => {
        if (!isCurrent()) return
        snapshots[index] = {
          ...snapshots[index],
          ...update,
        }
        if (successfulNavigationLoads > 0) publish()
      }
      const mergeCollaborationGroups = (index: number, groups: CollaborationGroup[]) => {
        updateSnapshot(index, {
          collaborationGroups: mergeByKey(
            [snapshots[index].collaborationGroups, groups],
            group => group.id
          ),
        })
      }
      // Navigation sources own independent storage, not resource identity.
      if (api.resources && (rootView === 'agents' || rootView === 'teams')) {
        void api.resources
          .list()
          .then(resources => {
            updateSnapshot(0, { resources })
          })
          .catch(() => undefined)
      }
      for (const [index, source] of sources.entries()) {
        if (rootView === 'inbox') {
          void loadRootMyWork(source).then(myWork => {
            updateSnapshot(index, { myWork })
          })
        }
      }
      const navigationCollection = Promise.allSettled(
        sources.flatMap((source, index) => {
          const loads: Promise<void>[] = [
            source.projects.list().then(projects => {
              if (!isCurrent()) return
              successfulNavigationLoads += 1
              updateSnapshot(index, { projects })
              if (rootView === 'teams' && source.projects.listCollaborationGroups) {
                void Promise.all(
                  projects.map(async project => {
                    try {
                      const groups = await source.projects.listCollaborationGroups!(project.id)
                      return groups.filter(
                        group => group.owner_type === 'project' && group.owner_id === project.id
                      )
                    } catch {
                      return []
                    }
                  })
                ).then(groups => {
                  mergeCollaborationGroups(index, groups.flat())
                })
              }
            }),
          ]
          if (source.workspaces) {
            loads.push(
              source.workspaces.list().then(workspaces => {
                if (!isCurrent()) return
                successfulNavigationLoads += 1
                updateSnapshot(index, { workspaces })
                if (rootView === 'teams') {
                  void Promise.all(
                    workspaces.map(workspace =>
                      source.workspaces!.listCollaborationGroups(workspace.id).catch(() => [])
                    )
                  ).then(groups => {
                    mergeCollaborationGroups(index, groups.flat())
                  })
                }
              })
            )
          }
          return loads
        })
      )
      const results = await collectNavigation(navigationCollection)
      primaryNavigationSettled = true
      navigationComplete = results.every(result => result.status === 'fulfilled')
      if (isCurrent()) {
        navigation.status = navigationComplete ? 'complete' : 'partial'
      }
      if (successfulNavigationLoads > 0) {
        publish()
      }
      if (
        isCurrent() &&
        successfulNavigationLoads === 0 &&
        results.every(result => result.status === 'rejected')
      ) {
        setState(current => ({
          ...current,
          loading: false,
          error: loadFailedMessage,
        }))
      }
      return
    }
    try {
      const cachedNavigation = navigation.cache
      const projectNavigation = (collections: NavigationCollections, pending = false) =>
        reconcileNavigationProjects(
          mergeByKey(
            [
              requestedProjectAuthorized && requestedProject ? [requestedProject] : [],
              collections.projects,
              !requestedProjectAuthorized && requestedProject && pending ? [requestedProject] : [],
            ],
            project => project.id
          ),
          cachedNavigation.projects
        )
      const publishNavigationTarget = (collections: NavigationCollections) => {
        if (!isCurrent()) return
        const projects = projectNavigation(collections, true)
        const target = projects.find(project => project.id === location.projectId)
        const workspace =
          collections.workspaces.find(candidate => candidate.id === workspaceId) ?? null
        const parentContext = target?.workspace_context
        if (!workspace && !parentContext) return
        if (location.projectId && !target) return
        setState(current => ({
          ...current,
          workspaces: collections.workspaces,
          workspace,
          workspaceNavigationContext:
            !workspace && parentContext ? { ...parentContext, location: 'cloud' } : null,
          navigationProjects: projects,
          navigationIncomplete: !collections.complete,
          projects: location.projectId
            ? projects
            : projects.filter(project => project.workspace_id === workspaceId),
          projectIssues: {},
          myWork: [],
          members: [],
          agents: [],
          collaborationGroups: [],
          executionEnvironments: [],
          resources: emptyResources,
          loading: false,
          error: null,
        }))
      }
      publishNavigationTarget({
        ...cachedNavigation,
        complete: navigation.status === 'complete',
        successfulLoads: 0,
      })
      const cachedWorkspace = cachedNavigation.workspaces.find(
        workspace => workspace.id === workspaceId
      )
      const cachedWorkspaceProjects = cachedNavigation.projects.filter(
        project => project.workspace_id === workspaceId
      )
      const targetCoveredByCache =
        Boolean(cachedWorkspace) &&
        (location.projectId
          ? cachedWorkspaceProjects.some(project => project.id === location.projectId)
          : cachedWorkspace?.project_count === 0 || cachedWorkspaceProjects.length > 0)
      // Mutations can seed a target before navigation sources have settled.
      const canUseNavigationCache =
        !force &&
        (navigation.status === 'complete' ||
          (navigation.status === 'partial' && targetCoveredByCache && !navigation.pending))
      const navigationCollections = canUseNavigationCache
        ? {
            ...cachedNavigation,
            complete: navigation.status === 'complete',
            successfulLoads: 1,
          }
        : await collectNavigation(loadNavigationCollections(sources, publishNavigationTarget))
      if (!isCurrent()) return
      const { workspaces, complete } = navigationCollections
      const navigationProjects = projectNavigation(navigationCollections)
      navigation.cache = {
        workspaces,
        projects: navigationProjects,
      }
      navigation.status = complete ? 'complete' : 'partial'
      setState(current => ({
        ...current,
        navigationIncomplete: !complete,
        navigationProjects,
        projects: navigationProjects.filter(project => project.workspace_id === workspaceId),
      }))
      const targetProjectLoaded =
        !location.projectId || navigationProjects.some(project => project.id === location.projectId)
      if (
        (!location.projectId && navigationCollections.successfulLoads === 0) ||
        (!complete && !targetProjectLoaded)
      ) {
        throw new Error(loadFailedMessage)
      }
      const workspaceSummary = workspaces.find(candidate => candidate.id === workspaceId) ?? null
      const workspaceProjects = navigationProjects.filter(
        project => project.workspace_id === workspaceId
      )
      if (workspaceSummary) {
        setState(current => ({
          ...current,
          workspaces,
          workspace: workspaceSummary,
          workspaceNavigationContext: null,
          navigationProjects,
          projects: location.projectId ? navigationProjects : workspaceProjects,
          projectIssues: {},
          myWork: [],
          members: [],
          agents: [],
          collaborationGroups: [],
          executionEnvironments: [],
          resources: emptyResources,
          loading: false,
          error: null,
        }))
      }
      if (location.projectId) {
        const parentContext = workspaceProjects.find(
          project => project.id === location.projectId
        )?.workspace_context
        const workspaceNavigationContext = workspaceSummary
          ? null
          : parentContext
            ? { ...parentContext, location: 'cloud' as const }
            : api.workspaces.getNavigationContext
              ? await collectNavigation(api.workspaces.getNavigationContext(workspaceId))
              : null
        if (!isCurrent()) return
        if (!workspaceSummary && !workspaceNavigationContext) {
          throw new Error(loadFailedMessage)
        }
        setState(current => ({
          ...current,
          workspaces,
          workspace: workspaceSummary,
          workspaceNavigationContext,
          navigationProjects,
          projects: navigationProjects.filter(project => project.workspace_id === workspaceId),
          projectIssues: {},
          myWork: [],
          members: [],
          agents: [],
          collaborationGroups: [],
          executionEnvironments: [],
          resources: emptyResources,
          loading: false,
        }))
        return
      }
      const workspaceView = location.workspaceView ?? 'home'
      const workspace = await collectNavigation(api.workspaces.get(workspaceId))
      if (!isCurrent()) return
      setState(current => ({
        ...current,
        workspaces,
        workspace,
        workspaceNavigationContext: null,
        navigationProjects,
        projects: workspaceProjects,
        projectIssues:
          workspaceView === 'home'
            ? Object.fromEntries(
                workspaceProjects.map(project => [project.id, { status: 'loading' }])
              )
            : {},
        myWork: [],
        members: [],
        agents: [],
        collaborationGroups: [],
        executionEnvironments: [],
        resources: emptyResources,
        loading: false,
      }))
      if (workspaceView === 'home' || workspaceView === 'projects') {
        void Promise.all([
          api.workspaces.listMembers(workspaceId),
          api.resources ? api.resources.list() : emptyResources,
        ])
          .then(([projectMembers, projectResources]) => {
            if (!isCurrent()) return
            setState(current => ({
              ...current,
              members: projectMembers,
              resources: projectResources,
            }))
          })
          .catch(() => undefined)
      }
      if (workspaceView === 'home') {
        for (const project of workspaceProjects) {
          void api.issues
            .getBoardSnapshot(project.id)
            .then(snapshot => {
              if (!isCurrent()) return
              setState(current => ({
                ...current,
                projectIssues: {
                  ...current.projectIssues,
                  [project.id]: {
                    status: 'available',
                    issues: snapshot.items,
                  },
                },
              }))
            })
            .catch(() => {
              if (!isCurrent()) return
              setState(current => ({
                ...current,
                projectIssues: {
                  ...current.projectIssues,
                  [project.id]: { status: 'unavailable' },
                },
              }))
            })
        }
      }
    } catch {
      if (!isCurrent()) return
      setState(current => ({
        ...current,
        loading: false,
        error: loadFailedMessage,
      }))
    }
  }
  const refreshPendingNavigation = () => {
    if (navigation.pending && listeners.size) void load(true)
  }
  const registerProject = (project: CollaborationProject) => {
    if (!listeners.size) return
    const cachedProject = navigation.cache.projects.find(candidate => candidate.id === project.id)
    const cachedProjectExists = Boolean(cachedProject)
    navigation.cache = {
      workspaces: navigation.cache.workspaces.map(workspace =>
        workspace.id === project.workspace_id && !cachedProjectExists
          ? {
              ...workspace,
              project_count: workspace.project_count + 1,
            }
          : workspace
      ),
      projects: [
        project,
        ...navigation.cache.projects.filter(candidate => candidate.id !== project.id),
      ],
    }
    setState(current => {
      const projectExists = current.navigationProjects.some(
        candidate => candidate.id === project.id
      )
      const updateWorkspace = (workspace: CollaborationWorkspace) =>
        workspace.id === project.workspace_id && !projectExists
          ? {
              ...workspace,
              project_count: workspace.project_count + 1,
            }
          : workspace
      return {
        ...current,
        projects: projectVisible(project, current, observation!.location)
          ? [project, ...current.projects.filter(candidate => candidate.id !== project.id)]
          : current.projects,
        projectIssues: {
          ...current.projectIssues,
          [project.id]: current.projectIssues[project.id] ?? {
            status: 'available',
            issues: [],
          },
        },
        navigationProjects: [
          project,
          ...current.navigationProjects.filter(candidate => candidate.id !== project.id),
        ],
        workspace: current.workspace ? updateWorkspace(current.workspace) : null,
        workspaces: current.workspaces.map(updateWorkspace),
      }
    })
    if (cachedProject !== project) refreshPendingNavigation()
  }
  const location = () => {
    if (!observation || !listeners.size) throw new Error('Platform controller is inactive')
    return observation.location
  }
  const mutations = createCollaborationPlatformMutations({
    api,
    navigation,
    location,
    publish: setState,
    publishWorkspace(workspaceId, update) {
      if (observation?.location.workspaceId === workspaceId) setState(update)
    },
    registerProject,
    refreshPendingNavigation,
    reload: () => load(true),
  })
  const commands = { reload: () => load(true), ...mutations, registerProject }
  return {
    getSnapshot: () => state,
    commands,
    api,
    sources,
    subscribe(next: PlatformLocationObservation, listener: () => void) {
      observation = { ...next, location: { ...next.location } }
      listeners.add(listener)
      const route = observation.location
      const keys = [
        route.projectId,
        route.rootView,
        route.projectId ? null : route.workspaceId,
        route.workspaceView,
        observation.loadFailedMessage,
        observation.refreshKey,
      ]
      const force = observedRefresh !== next.refreshKey
      observedRefresh = next.refreshKey
      if (!observedKeys || keys.some((value, index) => value !== observedKeys![index])) {
        observedKeys = keys
        void load(force)
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          loadRevision++
          navigation.pending = null
          observedKeys = undefined
        })
      }
    },
  }
}
