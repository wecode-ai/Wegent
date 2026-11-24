import type { WorkbenchSessionState } from './workbenchSessionState'
import type { WorkbenchSessionOperations } from './workbenchSessionOperations'
import type { WorkbenchSessionInput } from './workbenchSession'
import { assertLocalRuntimeSidebarIdentity } from '@/lib/local-runtime-sidebar-identity'
import {
  findActiveRuntimeProjectId,
  getRuntimeProjectActivation,
} from '@/lib/runtime-project-state'
import { findFirstSelectableProject } from './workbenchProviderHelpers'
import { readLastProjectId } from './workbenchRuntimeHelpers'
import { parseRuntimeTaskRoute } from '@/lib/navigation'
import { stripAppBasePath } from '@/config/runtime'
interface Owner {
  state: WorkbenchSessionState
  operations: WorkbenchSessionOperations
  inputs(): WorkbenchSessionInput
  isHeld(): boolean
  canNavigate(): boolean
  canSyncRemote(): boolean
  ownershipKey: string
}
/** Project restoration and native synchronization follow accepted state and owner activation events. */
export function createWorkbenchSessionProjects(owner: Owner) {
  const refs = owner.state.resources
  let previousState: ReturnType<WorkbenchSessionState['getSnapshot']>['state'] | null = null
  let previousInput: WorkbenchSessionInput | null = null
  let previousRemote = false
  let remoteRead = 0
  let activationRead = 0
  function restore() {
    const state = owner.state.getSnapshot().state
    if (
      refs.lastProjectRestoreAttemptedRef.current ||
      !state.runtimeWork ||
      state.runtimeWorkLoad.phase === 'loading' ||
      state.runtimeWorkLoad.phase === 'refreshing'
    )
      return
    if (
      refs.projectSelectionStartedRef.current ||
      parseRuntimeTaskRoute(stripAppBasePath(window.location.pathname), window.location.search) ||
      state.currentProject ||
      state.currentRuntimeTask ||
      state.standaloneWorkspacePath
    ) {
      refs.lastProjectRestoreAttemptedRef.current = true
      return
    }
    const last = readLastProjectId(owner.ownershipKey)
    refs.lastProjectRestoreAttemptedRef.current = true
    const project = findFirstSelectableProject(
      state.projects,
      state.runtimeWork,
      last === undefined ? [findActiveRuntimeProjectId(state.runtimeWork)] : [last]
    )
    if (project) owner.state.dispatch({ type: 'project_selected', project })
  }
  function syncRemote() {
    const input = owner.inputs()
    const readIdentity = input.services.getLocalRuntimeSidebarIdentity
    const state = owner.state.getSnapshot().state
    const read = ++remoteRead
    if (!owner.canSyncRemote() || !readIdentity || !state.runtimeWork) return
    let signature = ''
    let attempt: typeof refs.remoteProjectSyncAttemptRef.current = null
    void (async () => {
      const identity = await readIdentity()
      if (!owner.isHeld() || read !== remoteRead || !identity || !owner.canSyncRemote()) return
      const projects = input
        .getRemoteProjectRegistrations(identity)
        .sort((a, b) => a.id.localeCompare(b.id))
      if (!projects.length) {
        refs.remoteProjectSyncSignatureRef.current = ''
        return
      }
      signature = JSON.stringify({ identity, projects })
      if (refs.remoteProjectSyncSignatureRef.current === signature) return
      refs.remoteProjectSyncSignatureRef.current = signature
      const revision = refs.remoteProjectSyncRevisionRef.current
      attempt = {
        signature,
        queued: true,
        activationRevision: refs.remoteProjectSyncActivationRevisionRef.current,
      }
      refs.remoteProjectSyncAttemptRef.current = attempt
      const synced = await input.enqueueRemoteProjectStateMutation(async () => {
        const current = () =>
          owner.isHeld() &&
          refs.remoteProjectSyncAttemptRef.current === attempt &&
          revision === refs.remoteProjectSyncRevisionRef.current &&
          refs.remoteProjectSyncSignatureRef.current === signature
        if (!current()) {
          if (refs.remoteProjectSyncAttemptRef.current === attempt) {
            refs.remoteProjectSyncAttemptRef.current = null
            if (refs.remoteProjectSyncSignatureRef.current === signature)
              refs.remoteProjectSyncSignatureRef.current = ''
          }
          return
        }
        assertLocalRuntimeSidebarIdentity(identity, await readIdentity())
        if (!current() || !attempt) return
        attempt.queued = false
        const response = await input.executorClient.runtime.syncRuntimeRemoteProjects(
          { deviceId: identity.deviceId, projects: input.getRemoteProjectRegistrations(identity) },
          { localSidebarIdentity: identity }
        )
        if (!response.accepted) throw new Error(response.error || 'Failed to sync remote projects')
        return true
      })
      if (synced && owner.isHeld()) await owner.operations.stableRefreshWorkLists()
    })().catch(error => {
      if (!owner.isHeld()) return
      if (
        attempt &&
        refs.remoteProjectSyncAttemptRef.current === attempt &&
        refs.remoteProjectSyncSignatureRef.current === signature
      ) {
        refs.remoteProjectSyncSignatureRef.current = ''
        refs.remoteProjectSyncAttemptRef.current = null
        if (
          owner.canSyncRemote() &&
          refs.remoteProjectSyncActivationRevisionRef.current > attempt.activationRevision
        )
          syncRemote()
      }
      owner.state.dispatch({
        type: 'error_set',
        error: error instanceof Error ? error.message : String(error),
      })
      console.warn('[Wework] Failed to sync remote projects into Codex global state', error)
    })
  }
  function activateProject() {
    const read = ++activationRead
    const input = owner.inputs()
    const state = owner.state.getSnapshot().state
    if (state.currentRuntimeTask) {
      refs.projectActivationSignatureRef.current = ''
      return
    }
    const readIdentity = input.services.getLocalRuntimeSidebarIdentity
    if (
      !owner.canNavigate() ||
      !readIdentity ||
      !state.devices.some(device => device.device_type === 'local')
    )
      return
    void (async () => {
      const identity = await readIdentity()
      if (!owner.isHeld() || read !== activationRead || !owner.canNavigate() || !identity) return
      const latest = owner.state.getSnapshot().state
      const activation = getRuntimeProjectActivation(
        latest.runtimeWork,
        latest.currentProject?.id,
        identity.deviceId,
        latest.devices,
        identity
      )
      if (!activation) {
        refs.projectActivationSignatureRef.current = ''
        return
      }
      const signature = JSON.stringify({ activation, identity })
      if (refs.projectActivationSignatureRef.current === signature) return
      refs.projectActivationSignatureRef.current = signature
      await input.executorClient.runtime.activateRuntimeProject(activation, {
        localSidebarIdentity: identity,
      })
    })().catch(error => {
      if (!owner.isHeld()) return
      refs.projectActivationSignatureRef.current = ''
      console.warn('[Wework] Failed to save the active Codex project', error)
    })
  }
  return {
    reconcile() {
      const state = owner.state.getSnapshot().state
      const input = owner.inputs()
      const active = owner.canSyncRemote()
      const activationChanged = active !== previousRemote
      if (active && !previousRemote) refs.remoteProjectSyncActivationRevisionRef.current += 1
      if (!active && previousRemote) {
        refs.remoteProjectSyncRevisionRef.current += 1
        const attempt = refs.remoteProjectSyncAttemptRef.current
        if (attempt?.queued && refs.remoteProjectSyncSignatureRef.current === attempt.signature) {
          refs.remoteProjectSyncSignatureRef.current = ''
          refs.remoteProjectSyncAttemptRef.current = null
        }
      }
      const dataChanged =
        !previousState ||
        previousState.runtimeWork !== state.runtimeWork ||
        previousState.devices !== state.devices
      const serviceChanged =
        previousInput?.executorClient !== input.executorClient ||
        previousInput?.services.getLocalRuntimeSidebarIdentity !==
          input.services.getLocalRuntimeSidebarIdentity
      const selectionChanged =
        !previousState ||
        previousState.currentProject !== state.currentProject ||
        previousState.currentRuntimeTask !== state.currentRuntimeTask
      previousState = state
      previousInput = input
      previousRemote = active
      if (owner.canNavigate()) restore()
      if (dataChanged || activationChanged || serviceChanged) syncRemote()
      if (dataChanged || activationChanged || serviceChanged || selectionChanged) activateProject()
    },
    suspend() {
      remoteRead += 1
      activationRead += 1
      previousState = null
      previousInput = null
      previousRemote = false
    },
  }
}
