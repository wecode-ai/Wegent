import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import type { StandInBindingTarget, StandInInstanceBinding } from '@/api/standIn'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { reportStandInError } from '@/lib/stand-in-error-message'

interface RoleLocation {
  deviceId: string
  roleId?: string
  settings?: boolean
}
interface WorkspaceObservation {
  api: SharedWorkspaceApi | null
  bindingScope?: string
  target?: StandInBindingTarget | null
  bindingStatus?: StandInInstanceBinding['status']
  ownerAvailable: boolean
  active: boolean
  embedded: boolean
  contentRoute: string
  entryRequestKey?: number
  requestLeave(action: () => void): void
}
interface WorkspaceSnapshot {
  roleLocation?: RoleLocation
  selectionScope?: string
  projects: CollaborationProject[]
  projectsScope?: string
  projectsApi: SharedWorkspaceApi | null
  loadingProjects: boolean
  error: { kind: 'projects'; cause: unknown } | { kind: 'stop_before_rebind' } | null
}

/** Owns the account workspace's role navigation and independently loaded project directory. */
export function createPersonalStandInWorkspaceSource(
  contentRoute: string,
  entryRequestKey?: number
) {
  const query = new URLSearchParams(contentRoute.split('?')[1] ?? '')
  let snapshot: WorkspaceSnapshot = {
    roleLocation:
      query.get('profileId') && query.get('profileId') !== '@primary' && query.get('deviceId')
        ? { deviceId: query.get('deviceId')!, roleId: query.get('profileId')!, settings: true }
        : undefined,
    projects: [],
    projectsApi: null,
    loadingProjects: false,
    error: null,
  }
  const listeners = new Set<() => void>()
  let observation: WorkspaceObservation | undefined
  let previousEntry = JSON.stringify([contentRoute, entryRequestKey])
  let readRevision = 0
  let selectionRevision = 0
  const publish = (patch: Partial<WorkspaceSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const loadProjects = async () => {
    const owner = observation
    const revision = ++readRevision
    if (
      owner &&
      (snapshot.projectsScope !== owner.bindingScope || snapshot.projectsApi !== owner.api)
    )
      publish({
        projectsScope: owner.bindingScope,
        projectsApi: owner.api,
        projects: [],
        error: null,
      })
    if (
      !owner ||
      owner.embedded ||
      !owner.active ||
      !owner.api ||
      !owner.target ||
      !owner.ownerAvailable ||
      owner.bindingStatus !== 'active'
    ) {
      if (snapshot.loadingProjects) publish({ loadingProjects: false })
      return
    }
    const api = owner.api
    publish({ loadingProjects: true })
    try {
      const projects = await api.projects.list()
      if (listeners.size && readRevision === revision) publish({ projects, error: null })
    } catch (cause) {
      if (listeners.size && readRevision === revision) {
        reportStandInError('load_projects', cause)
        publish({ error: { kind: 'projects', cause } })
      }
    } finally {
      if (listeners.size && readRevision === revision) publish({ loadingProjects: false })
    }
  }
  const consumeEntry = () => {
    const owner = observation!
    const deviceId = owner.target?.deviceId
    const entry = JSON.stringify([owner.contentRoute, owner.entryRequestKey])
    if (previousEntry === entry || !deviceId) return
    previousEntry = entry
    const params = new URLSearchParams(owner.contentRoute.split('?')[1] ?? '')
    const roleId = params.get('profileId') ?? undefined
    const next = roleId && roleId !== '@primary' ? (params.get('deviceId') ?? deviceId) : deviceId
    const revision = selectionRevision
    owner.requestLeave(() => {
      if (!listeners.size || selectionRevision !== revision) return
      publish({
        roleLocation: { deviceId: next, roleId, settings: !!params.get('settingsRequest') },
      })
    })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(owner: WorkspaceObservation, listener: () => void) {
      const previous = observation
      observation = owner
      listeners.add(listener)
      if (owner.bindingScope && snapshot.selectionScope !== owner.bindingScope) {
        const changed = !!snapshot.selectionScope
        selectionRevision++
        publish({
          selectionScope: owner.bindingScope,
          ...(changed ? { roleLocation: undefined } : {}),
        })
      }
      consumeEntry()
      if (
        !previous ||
        previous.api !== owner.api ||
        previous.bindingScope !== owner.bindingScope ||
        previous.active !== owner.active ||
        previous.embedded !== owner.embedded ||
        previous.target !== owner.target ||
        previous.bindingStatus !== owner.bindingStatus ||
        previous.ownerAvailable !== owner.ownerAvailable
      )
        void loadProjects()
      if (
        owner.active &&
        !owner.embedded &&
        (!previous || !previous.active || previous.embedded) &&
        isElectronRuntime() &&
        getDesktopWindowLabel() === 'main'
      ) {
        void invokeDesktopHost<void>('renderer.startupReady').catch(cause => {
          console.error('[Wework] Failed to reveal the personal stand-in workspace', cause)
        })
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          readRevision++
          selectionRevision++
          observation = undefined
          publish({ loadingProjects: false })
        })
      }
    },
    selectLocation(deviceId: string, roleId?: string, settings?: boolean) {
      if (!observation || !listeners.size) return
      if ((!roleId || roleId === '@primary') && deviceId !== observation.target?.deviceId) {
        publish({ error: { kind: 'stop_before_rebind' } })
        return
      }
      publish({ roleLocation: { deviceId, roleId, settings } })
    },
    reloadProjects: () => {
      void loadProjects()
    },
  }
}
