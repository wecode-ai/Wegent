import type { SetStateAction } from 'react'
import type {
  LocalDeviceApp,
  LocalDeviceSkill,
  ProjectExecutionMode,
  RuntimeContextUsage,
  User,
  UserPreferences,
} from '@/types/api'
import type { RuntimeProjectSyncTarget } from '@/lib/runtime-project-identity'
import { syncRuntimeConversationDeviceAliases } from './runtimeConversationCache'
import {
  createRuntimeTaskLifecycleOwnershipView,
  type RuntimeTaskLifecycleStore,
} from './runtimeTaskLifecycle'
import {
  findProjectMetadataDeviceWorkspace,
  resolveComposerProjectPluginNames,
} from './workbenchRuntimeHelpers'
import {
  getProjectWorkPreferenceKey,
  readProjectWorkPreference,
  resolveProjectWorkPreferenceScope,
} from './projectWorkPreferences'
import { initialWorkbenchState, workbenchReducer, type WorkbenchAction } from './workbenchReducer'

export interface RemoteProjectSyncAttempt {
  signature: string
  queued: boolean
  activationRevision: number
}

/** The reducer and scoped draft choices are the canonical state of one Workbench owner. */
export function createWorkbenchSessionState(
  identity: User,
  sharedLifecycleStore: RuntimeTaskLifecycleStore,
  initialLifecycleEnabled: boolean
) {
  let alive = true
  let lifecycleEnabled = initialLifecycleEnabled
  let snapshot = {
    state: workbenchReducer(initialWorkbenchState, { type: 'user_updated', user: identity }),
    contextUsageByRuntimeTask: {} as Record<string, RuntimeContextUsage>,
    projectExecutionMode: 'current_workspace' as ProjectExecutionMode,
    projectWorktreeBranch: null as string | null,
  }
  const listeners = new Set<() => void>()
  const lifecycleStore = createRuntimeTaskLifecycleOwnershipView(
    sharedLifecycleStore,
    () => alive && lifecycleEnabled
  )
  const publish = () => {
    for (const listener of listeners) listener()
  }
  const preferenceScope = () => {
    const state = snapshot.state
    return resolveProjectWorkPreferenceScope(
      state.currentProject,
      findProjectMetadataDeviceWorkspace(
        state.runtimeWork,
        state.currentProject?.id,
        state.selectedDeviceWorkspaceId
      )
    )
  }
  const syncLifecycle = (previous: typeof snapshot.state | null) => {
    const state = snapshot.state
    if (!previous || previous.devices !== state.devices) {
      syncRuntimeConversationDeviceAliases(state.devices)
      lifecycleStore.syncDevices(state.devices)
    }
    if (!previous || previous.runtimeWork !== state.runtimeWork)
      lifecycleStore.syncRuntimeWork(state.runtimeWork)
    if (!previous || previous.currentRuntimeTask !== state.currentRuntimeTask)
      lifecycleStore.setCurrentTask(state.currentRuntimeTask)
  }
  const dispatch = (action: WorkbenchAction) => {
    if (!alive) return
    const previous = snapshot.state
    if (
      action.type === 'user_preferences_updated' &&
      previous.user?.preferences === action.preferences
    )
      return
    const previousPreferenceKey = getProjectWorkPreferenceKey(preferenceScope())
    const state = workbenchReducer(previous, action)
    if (state === previous) return
    snapshot = { ...snapshot, state }
    if (
      previous.user?.preferences !== state.user?.preferences ||
      previousPreferenceKey !== getProjectWorkPreferenceKey(preferenceScope())
    ) {
      const preference = readProjectWorkPreference(
        state.user?.preferences ?? identity.preferences,
        preferenceScope()
      ).preference
      snapshot = {
        ...snapshot,
        projectExecutionMode: preference.executionMode,
        projectWorktreeBranch: preference.worktreeBranch,
      }
    }
    syncLifecycle(previous)
    publish()
  }
  const resources = {
    runtimeTaskSettleSyncGenerationRef: { current: new Map<string, number>() },
    runtimeTaskSettleSyncGenerationCounterRef: { current: 0 },
    runtimeTaskSettleSyncActiveRef: {
      get current() {
        return alive && lifecycleEnabled
      },
    },
    remoteProjectSyncSignatureRef: { current: '' },
    remoteProjectSyncRevisionRef: { current: 0 },
    remoteProjectSyncAttemptRef: { current: null as RemoteProjectSyncAttempt | null },
    remoteProjectSyncActivationRevisionRef: { current: 0 },
    removedRemoteProjectsRef: { current: [] as RuntimeProjectSyncTarget[] },
    remoteProjectMutationQueueRef: { current: Promise.resolve() },
    projectWorkPreferenceMutationQueueRef: { current: Promise.resolve() },
    modelSelectionMutationQueueRef: { current: Promise.resolve() },
    projectActivationSignatureRef: { current: '' },
    lastProjectRestoreAttemptedRef: { current: false },
    projectSelectionStartedRef: { current: false },
    localSkillsCacheRef: {
      current: new Map<string, { expiresAt: number; skills: LocalDeviceSkill[] }>(),
    },
    localAppsInflightRef: { current: null as Promise<LocalDeviceApp[]> | null },
    localAppsLoadGenerationRef: { current: 0 },
    localAppsRefreshTimerRef: { current: null as number | null },
    localAppsRequestedRef: { current: false },
    activeProjectWorkPreferenceKeyRef: {
      get current() {
        return getProjectWorkPreferenceKey(preferenceScope())
      },
    },
    latestUserPreferencesRef: {
      get current(): UserPreferences | null | undefined {
        return snapshot.state.user?.preferences ?? identity.preferences
      },
      set current(preferences: UserPreferences | null | undefined) {
        if (preferences) dispatch({ type: 'user_preferences_updated', preferences })
      },
    },
    sidebarDevicesRef: {
      get current() {
        return snapshot.state.devices
      },
    },
    projectPluginNamesRef: {
      get current() {
        const state = snapshot.state
        const names = resolveComposerProjectPluginNames(
          state.runtimeWork,
          state.currentProject?.id,
          state.currentRuntimeTask
        )
        return names === null ? null : new Set(names)
      },
    },
  }
  return {
    lifecycleStore,
    resources,
    getSnapshot: () => snapshot,
    getCurrentRuntimeTask: () => snapshot.state.currentRuntimeTask,
    dispatch,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isAlive: () => alive,
    canSyncLifecycle: () => alive && lifecycleEnabled,
    setLifecycleEnabled(enabled: boolean) {
      if (lifecycleEnabled === enabled) return
      lifecycleEnabled = enabled
      if (enabled) syncLifecycle(null)
    },
    setContextUsageByRuntimeTask(value: SetStateAction<Record<string, RuntimeContextUsage>>) {
      if (!alive) return
      const next = typeof value === 'function' ? value(snapshot.contextUsageByRuntimeTask) : value
      if (next === snapshot.contextUsageByRuntimeTask) return
      snapshot = { ...snapshot, contextUsageByRuntimeTask: next }
      publish()
    },
    setProjectExecutionMode(value: SetStateAction<string>) {
      if (!alive || snapshot.state.currentRuntimeTask) return
      const next = typeof value === 'function' ? value(snapshot.projectExecutionMode) : value
      const projectExecutionMode = next === 'git_worktree' ? 'git_worktree' : 'current_workspace'
      if (projectExecutionMode === snapshot.projectExecutionMode) return
      snapshot = { ...snapshot, projectExecutionMode }
      publish()
    },
    setProjectWorktreeBranchState(value: SetStateAction<string | null>) {
      if (!alive || snapshot.state.currentRuntimeTask) return
      const next = typeof value === 'function' ? value(snapshot.projectWorktreeBranch) : value
      if (next === snapshot.projectWorktreeBranch) return
      snapshot = { ...snapshot, projectWorktreeBranch: next }
      publish()
    },
    activate() {
      alive = true
      syncLifecycle(null)
    },
    dispose() {
      alive = false
      resources.runtimeTaskSettleSyncGenerationRef.current.clear()
      resources.localAppsLoadGenerationRef.current += 1
      resources.localAppsInflightRef.current = null
      if (resources.localAppsRefreshTimerRef.current !== null)
        window.clearTimeout(resources.localAppsRefreshTimerRef.current)
      resources.localAppsRefreshTimerRef.current = null
    },
  }
}
export type WorkbenchSessionState = ReturnType<typeof createWorkbenchSessionState>
