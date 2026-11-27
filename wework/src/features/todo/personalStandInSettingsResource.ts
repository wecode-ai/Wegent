import type { PersonalStandInSettings, StandInRole } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { dequal } from 'dequal'
import { createStandInRoleDraft, type InitialStandInRoleRequest } from './standInRoleDraft'
import { PersonalAssistantDefinitionSaveError } from './personalAssistantDeviceSettings'

type Failure = { cause: unknown; operation: 'load_settings_failed' | 'save_settings_failed' }
type ErrorState = Failure | string | null
export interface PersonalStandInObservation {
  onSavingChange?(saving: boolean): void
  initialRole?: InitialStandInRoleRequest
}
interface SettingsState {
  saved: PersonalStandInSettings | null
  draft: PersonalStandInSettings | null
  currentDeviceId: string
  loadedDeviceId: string | undefined
  loading: boolean
  saving: boolean
  moving: boolean
  initialRoleCreation?: { roleId: string; baseline: PersonalStandInSettings }
  error: ErrorState
}

export function personalStandInSettingsError(error: ErrorState): string | null {
  return typeof error === 'string' || error === null
    ? error
    : getStandInErrorMessage(error.cause, error.operation)
}

function appendedRole(
  baseline: PersonalStandInSettings,
  draft: PersonalStandInSettings,
  change: Parameters<StandInExecutorApi['personalSave']>[4]
) {
  if (change?.kind !== 'create') return
  const role = draft.roles.find(role => role.id === change.roleId)
  if (
    role &&
    !baseline.roles.some(item => item.id === role.id) &&
    dequal(baseline, { ...draft, roles: draft.roles.filter(item => item.id !== role.id) })
  )
    return role
}

/** One account and Executor own the read, editable draft, and accepted writes. */
export function createPersonalStandInSettingsResource({
  api,
  identify,
  userId,
  deviceId,
  localDeviceId,
}: {
  api: WorkbenchServices['standInApi']
  identify: WorkbenchServices['getLocalRuntimeSidebarIdentity']
  userId: number
  deviceId: string
  localDeviceId?: string
}) {
  const listeners = new Set<() => void>()
  const observations = new Map<
    () => void,
    { input: PersonalStandInObservation; saving?: boolean }
  >()
  let initialRoleCreation: SettingsState['initialRoleCreation']
  let moving = false
  let unsubscribe: (() => void) | undefined
  let draft: PersonalStandInSettings | null | undefined
  let editRevision = 0
  let resetRevision: number | undefined
  let saving = false
  let errorOverride: ErrorState | undefined
  let definitionConflict: { cause: unknown; revision: string | undefined } | undefined
  const resource = createAsyncResource(
    JSON.stringify(['personal-stand-in', userId, deviceId, localDeviceId]),
    async signal => {
      if (!api) throw new Error('Executor identity is unavailable')
      const identity = localDeviceId ? { deviceId: localDeviceId } : await identify?.()
      signal.throwIfAborted()
      if (!identity) throw new Error('Executor identity is unavailable')
      const target = deviceId || identity.deviceId
      const settings = await api.personalGet(userId, target)
      return { settings, deviceId: target, currentDeviceId: identity.deviceId }
    },
    {
      success(data) {
        if (
          resetRevision === editRevision &&
          (!definitionConflict ||
            data.settings.cloudDefinitionRevision !== definitionConflict.revision)
        ) {
          draft = undefined
          definitionConflict = undefined
        }
        resetRevision = undefined
        errorOverride = definitionConflict
          ? { cause: definitionConflict.cause, operation: 'save_settings_failed' }
          : undefined
        publish()
      },
      failure(cause) {
        reportStandInError('load_settings', cause, deviceId)
      },
    }
  )
  let state: SettingsState = {
    saved: null,
    draft: null,
    currentDeviceId: '',
    loadedDeviceId: deviceId || undefined,
    loading: true,
    saving: false,
    moving: false,
    error: null,
  }
  function publish() {
    const snapshot = resource.getSnapshot()
    if (snapshot.status === 'ready' && snapshot.data && !initialRoleCreation && listeners.size) {
      const request = [...observations.values()].find(observation => observation.input.initialRole)
        ?.input.initialRole
      const baseline = draft === undefined ? snapshot.data.settings : draft
      if (request && baseline) {
        const created = createStandInRoleDraft(baseline, request)
        draft = created.draft
        editRevision += 1
        initialRoleCreation = { roleId: created.role.id, baseline }
      }
    }
    state = {
      saved: snapshot.data?.settings ?? null,
      draft: draft === undefined ? (snapshot.data?.settings ?? null) : draft,
      currentDeviceId: snapshot.data?.currentDeviceId ?? '',
      loadedDeviceId: snapshot.data?.deviceId ?? (deviceId || undefined),
      loading: snapshot.status === 'idle' || snapshot.status === 'loading',
      saving: saving || moving,
      moving,
      initialRoleCreation,
      error:
        errorOverride !== undefined
          ? errorOverride
          : snapshot.status === 'error'
            ? { cause: snapshot.error, operation: 'load_settings_failed' }
            : null,
    }
    listeners.forEach(listener => listener())
    for (const [listener, observation] of observations) {
      if (!listeners.has(listener) || observation.saving === state.saving) continue
      observation.saving = state.saving
      observation.input.onSavingChange?.(state.saving)
    }
  }
  const setDraft = (
    value:
      | PersonalStandInSettings
      | null
      | ((current: PersonalStandInSettings | null) => PersonalStandInSettings | null)
  ) => {
    if (!listeners.size) return
    draft = typeof value === 'function' ? value(state.draft) : value
    editRevision += 1
    publish()
  }
  return {
    getSnapshot: () => state,
    isActive: () => listeners.size > 0,
    subscribe(listener: () => void, observation: PersonalStandInObservation = {}) {
      listeners.add(listener)
      observations.set(listener, { input: observation })
      if (!unsubscribe) unsubscribe = resource.subscribe(publish)
      publish()
      return () => {
        listeners.delete(listener)
        observations.delete(listener)
        // A callback metadata update must not abort the existing settings read.
        queueMicrotask(() => {
          if (listeners.size) return
          unsubscribe?.()
          unsubscribe = undefined
        })
      }
    },
    setMoving(value: boolean) {
      if (value && !listeners.size) return
      if (moving === value) return
      moving = value
      publish()
    },
    setDraft,
    updateRole(id: string, update: (role: StandInRole) => StandInRole) {
      setDraft(
        current =>
          current && {
            ...current,
            roles: current.roles.map(role => (role.id === id ? update(role) : role)),
          }
      )
    },
    setError(value: string | null | ((current: string | null) => string | null)) {
      if (!listeners.size) return
      errorOverride =
        typeof value === 'function' ? value(personalStandInSettingsError(state.error)) : value
      publish()
    },
    reload() {
      if (!listeners.size) return
      resetRevision = editRevision
      errorOverride = undefined
      void resource.reload()
    },
    async save(
      value = state.draft,
      definitionChange?: Parameters<StandInExecutorApi['personalSave']>[4]
    ) {
      const loaded = resource.getSnapshot().data
      if (!listeners.size || !api || !value || saving || moving || state.loading || !loaded)
        return null
      if (definitionConflict) {
        errorOverride = { cause: definitionConflict.cause, operation: 'save_settings_failed' }
        publish()
        return null
      }
      const submittedRevision = editRevision
      saving = true
      errorOverride = null
      publish()
      try {
        const added = appendedRole(loaded.settings, value, definitionChange)
        if (added) {
          // Appending an independent role must preserve concurrent edits to the profile.
          const latest = await api.personalGet(userId, loaded.deviceId)
          if (!listeners.size) return null
          if (
            latest.userId === userId &&
            latest.executionDeviceId === loaded.settings.executionDeviceId &&
            latest.lifecycle?.status === loaded.settings.lifecycle?.status &&
            !latest.roles.some(role => role.id === added.id)
          )
            value = { ...latest, roles: [...latest.roles, added] }
        }
        const receipt = definitionChange
          ? await api.personalSave(userId, value, loaded.deviceId, undefined, definitionChange)
          : await api.personalSave(userId, value, loaded.deviceId)
        if (!listeners.size) return null
        if (editRevision === submittedRevision) draft = undefined
        resource.update(() => ({ ...loaded, settings: receipt }))
        return receipt
      } catch (cause) {
        reportStandInError('save_settings', cause, loaded.deviceId)
        if (
          listeners.size &&
          cause &&
          typeof cause === 'object' &&
          'code' in cause &&
          cause.code === 'cloud_definition_version_conflict'
        ) {
          definitionConflict = { cause, revision: value.cloudDefinitionRevision }
        }
        if (listeners.size && cause instanceof PersonalAssistantDefinitionSaveError) {
          const edited = draft ?? value
          draft = {
            ...edited,
            version: cause.saved.version,
          }
          resource.update(() => ({ ...loaded, settings: cause.saved }))
        }
        if (listeners.size) errorOverride = { cause, operation: 'save_settings_failed' }
        return null
      } finally {
        saving = false
        publish()
      }
    },
  }
}
