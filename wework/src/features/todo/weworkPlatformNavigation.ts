import type { CollaborationPlatformLocation, CollaborationProject } from '@wegent/collaboration'
import type { WeworkCollaborationPlatformProps } from './weworkCollaborationTypes'
import { LOCAL_WORKSPACE_ID } from './localWorkspaceApi'
import { initialLocation, routeProjectLocation } from './weworkCollaborationRuntime'
import type { LocatedProjectSpace } from './projectSpaceSelection'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'

export interface PlatformNavigationInput {
  api: { projects: { get(id: string): Promise<CollaborationProject> } } | null | undefined
  activeProject: WeworkCollaborationPlatformProps['activeProjectRef']
  focusedItemId: WeworkCollaborationPlatformProps['focusedItemId']
  focusedCommentId: WeworkCollaborationPlatformProps['focusedCommentId']
  focusedCommentRequestKey: WeworkCollaborationPlatformProps['focusedCommentRequestKey']
  onActiveProjectChange: WeworkCollaborationPlatformProps['onActiveProjectChange']
  startupActive: WeworkCollaborationPlatformProps['startupActive']
}
export function createWeworkPlatformNavigation(initial: PlatformNavigationInput) {
  let snapshot = {
    location: {
      ...(routeProjectLocation(initial.activeProject ?? null, initial.focusedItemId ?? null) ??
        initialLocation),
    },
    personalHomeEntryKey: 0,
  }
  let input = initial
  const observers = new Map<() => void, PlatformNavigationInput>()
  let generation = 0
  let navigationRevision = 0
  let pendingProjectId: string | null | undefined
  let observedApi: PlatformNavigationInput['api']
  let routeKey: string | undefined
  let resolvedWorkspaceKey: string | null = null
  let resolvingWorkspaceKey: string | null = null
  let routeLookupRevision = 0
  let startupReadySent = false
  const active = () => observers.size > 0
  const publish = (location: CollaborationPlatformLocation, homeEntry = false) => {
    snapshot = {
      location,
      personalHomeEntryKey: snapshot.personalHomeEntryKey + (homeEntry ? 1 : 0),
    }
    observers.forEach((_, listener) => listener())
  }
  function syncRoute(force = false) {
    const apiChanged = observedApi !== input.api
    observedApi = input.api
    const externalKey = JSON.stringify([
      input.activeProject?.projectId,
      input.activeProject?.projectStore,
      input.focusedItemId,
      input.focusedCommentId,
      input.focusedCommentRequestKey,
    ])
    const routeChanged = externalKey !== routeKey
    if (routeChanged) {
      routeKey = externalKey
      navigationRevision++
      routeLookupRevision++
      resolvingWorkspaceKey = null
      pendingProjectId = undefined
    }
    const projectId = input.activeProject ? String(input.activeProject.projectId) : null
    if (pendingProjectId !== undefined) {
      if (pendingProjectId !== projectId) return
      pendingProjectId = undefined
    }
    const store = input.activeProject?.projectStore
    if (!input.api?.projects.get || !projectId || !store) return
    const target = routeProjectLocation(
      { projectId, projectStore: store },
      input.focusedItemId ?? null
    )!
    const current = snapshot.location
    const moving =
      String(current.projectId ?? '') !== projectId ||
      current.collaborationDomain !== (store === 'local' ? 'local' : 'cloud')
    if ((routeChanged || force || apiChanged) && (moving || input.focusedItemId != null)) {
      const issueId = moving
        ? (input.focusedItemId ?? null)
        : (input.focusedItemId ?? current.issueId)
      if (
        moving ||
        current.issueId !== issueId ||
        current.workspaceView !== target.workspaceView ||
        current.projectView !== target.projectView
      )
        publish({ ...current, ...target, issueId, projectSettingsSection: null })
    }
    const workspaceKey = JSON.stringify([store, projectId])
    if (resolvedWorkspaceKey === workspaceKey || resolvingWorkspaceKey === workspaceKey) return
    resolvingWorkspaceKey = workspaceKey
    const epoch = generation
    const revision = ++routeLookupRevision
    const api = input.api
    void api.projects
      .get(projectId)
      .then(project => {
        if (!active() || generation !== epoch || revision !== routeLookupRevision) return
        resolvingWorkspaceKey = null
        resolvedWorkspaceKey = workspaceKey
        const current = snapshot.location
        if (String(current.projectId ?? '') !== projectId) return
        const collaborationDomain = project.project_store === 'local' ? 'local' : 'cloud'
        const workspaceId = project.workspace_id ?? null
        if (
          current.collaborationDomain !== collaborationDomain ||
          current.workspaceId !== workspaceId
        )
          publish({ ...current, collaborationDomain, workspaceId })
      })
      .catch(() => {
        if (generation === epoch && revision === routeLookupRevision) {
          resolvingWorkspaceKey = null
          // Keep the board available when workspace metadata cannot be loaded.
          resolvedWorkspaceKey = workspaceKey
        }
      })
  }
  function publishActiveProject(project: LocatedProjectSpace | null) {
    if (active()) input.onActiveProjectChange?.(project)
  }
  return {
    getProjectStore(projectId: string): 'local' | 'cloud' | undefined {
      if (String(snapshot.location.projectId ?? '') === projectId)
        return snapshot.location.collaborationDomain
      if (String(input.activeProject?.projectId ?? '') === projectId)
        return input.activeProject?.projectStore === 'local' ? 'local' : 'cloud'
      return undefined
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: PlatformNavigationInput) {
      observers.set(listener, next)
      input = next
      syncRoute()
      return () => {
        observers.delete(listener)
        input = [...observers.values()].at(-1) ?? input
        queueMicrotask(() => {
          if (active()) return
          generation++
          navigationRevision++
          routeLookupRevision++
          resolvingWorkspaceKey = null
        })
      }
    },
    updateLocation(location: CollaborationPlatformLocation) {
      if (active()) publish(location)
    },
    navigate(location: CollaborationPlatformLocation, resolvedProject?: LocatedProjectSpace) {
      if (!active()) return
      const revision = ++navigationRevision
      const epoch = generation
      if (input.onActiveProjectChange)
        pendingProjectId = location.projectId ? String(location.projectId) : null
      publish(
        {
          ...location,
          projectSettingsSection:
            location.projectView === 'manage' ? (location.projectSettingsSection ?? null) : null,
        },
        !location.projectId && !location.workspaceId && (location.rootView ?? 'home') === 'home'
      )
      if (!location.projectId) {
        publishActiveProject(null)
        return
      }
      const projectId = String(location.projectId)
      const api = input.api
      if (!api?.projects.get) return
      void (resolvedProject ? Promise.resolve(resolvedProject) : api.projects.get(projectId))
        .then(project => {
          if (!active() || epoch !== generation || revision !== navigationRevision) return
          publishActiveProject({
            ...project,
            location: project.project_store === 'local' ? 'local' : 'cloud',
          })
        })
        .catch(() => {
          if (!active() || epoch !== generation || revision !== navigationRevision) return
          pendingProjectId = undefined
          syncRoute(true)
        })
    },
    openKnownProject(project: CollaborationProject, issueId: string) {
      if (!active()) return
      navigationRevision++
      pendingProjectId = input.onActiveProjectChange ? String(project.id) : undefined
      publish({
        ...routeProjectLocation(
          { projectId: String(project.id), projectStore: project.project_store },
          issueId
        )!,
        workspaceId:
          project.project_store === 'local' ? LOCAL_WORKSPACE_ID : (project.workspace_id ?? null),
        projectSettingsSection: null,
      })
      publishActiveProject({
        ...project,
        location: project.project_store === 'local' ? 'local' : 'cloud',
      } as LocatedProjectSpace)
    },
    handleReady() {
      const routeReady =
        !input.activeProject ||
        String(snapshot.location.projectId) === String(input.activeProject.projectId)
      if (
        !input.startupActive ||
        !routeReady ||
        startupReadySent ||
        !isElectronRuntime() ||
        getDesktopWindowLabel() !== 'main'
      )
        return
      startupReadySent = true
      void invokeDesktopHost<void>('renderer.startupReady').catch(cause => {
        console.error('[Wework] Failed to reveal the ready collaboration space', cause)
      })
    },
  }
}
