import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import type { StandInBindingTarget } from '@/api/standIn'
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
  accountScope?: string
  target?: StandInBindingTarget | null
  entry?: { key: string; location?: RoleLocation }
  active: boolean
  embedded: boolean
  requestLeave(action: () => void): void
}
interface WorkspaceSnapshot {
  roleLocation?: RoleLocation
  entryKey?: string
  selectionScope?: string
  projects: CollaborationProject[]
  projectsScope?: string
  projectsApi: SharedWorkspaceApi | null
  loadingProjects: boolean
  error: { kind: 'projects'; cause: unknown } | null
}

/** Owns the account workspace's role navigation and independently loaded project directory. */
export function createPersonalStandInWorkspaceSource() {
  let snapshot: WorkspaceSnapshot = {
    projects: [],
    projectsApi: null,
    loadingProjects: false,
    error: null,
  }
  const listeners = new Set<() => void>()
  let observation: WorkspaceObservation | undefined
  let previousEntry: string | undefined
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
      (snapshot.projectsScope !== owner.accountScope || snapshot.projectsApi !== owner.api)
    )
      publish({
        projectsScope: owner.accountScope,
        projectsApi: owner.api,
        projects: [],
        error: null,
      })
    if (!owner || owner.embedded || !owner.active || !owner.api || !owner.target) {
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
    const entry = owner.entry
    if (previousEntry === entry?.key || !entry) return
    previousEntry = entry.key
    const revision = selectionRevision
    owner.requestLeave(() => {
      if (!listeners.size || selectionRevision !== revision) return
      publish({
        entryKey: entry.key,
        roleLocation: entry.location,
      })
    })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(owner: WorkspaceObservation, listener: () => void) {
      const previous = observation
      observation = owner
      listeners.add(listener)
      if (owner.accountScope && snapshot.selectionScope !== owner.accountScope) {
        const changed = !!snapshot.selectionScope
        selectionRevision++
        publish({
          selectionScope: owner.accountScope,
          ...(changed ? { roleLocation: undefined } : {}),
        })
      }
      consumeEntry()
      if (
        !previous ||
        previous.api !== owner.api ||
        previous.accountScope !== owner.accountScope ||
        previous.active !== owner.active ||
        previous.embedded !== owner.embedded ||
        previous.target !== owner.target
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
      publish({ roleLocation: { deviceId, roleId, settings } })
    },
    reloadProjects: () => {
      void loadProjects()
    },
  }
}
