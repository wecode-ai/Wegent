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

// Preserve accepted peer values unless the draft independently changed that field.
// Composite permission and connection fields remain atomic when both writers edited them.
function rebaseFields<T extends object>(
  before: T | undefined,
  edited: T | undefined,
  latest: T | undefined
): { value: T | undefined } | null {
  if (dequal(before, edited)) return { value: latest }
  if (dequal(before, latest) || dequal(edited, latest)) return { value: edited }
  if (!before || !edited || !latest) return null
  const value = { ...latest }
  const fields = new Set([...Object.keys(before), ...Object.keys(edited)] as (keyof T)[])
  for (const field of fields) {
    if (dequal(before[field], edited[field])) continue
    if (!dequal(before[field], latest[field]) && !dequal(edited[field], latest[field])) return null
    value[field] = edited[field]
  }
  return { value }
}

function rebaseRetainedDraft(
  before: PersonalStandInSettings,
  edited: PersonalStandInSettings,
  latest: PersonalStandInSettings
): PersonalStandInSettings | undefined {
  if (before.userId !== latest.userId || before.executionDeviceId !== latest.executionDeviceId)
    return
  const primary = rebaseFields(before.primary, edited.primary, latest.primary)
  if (!primary) return
  // Roles are identified by ID, so an independent edit cannot revive a removed role
  // or discard another client's newly created role.
  const previous = new Map(before.roles.map(role => [role.id, role]))
  const changes = new Map(edited.roles.map(role => [role.id, role]))
  const roles = new Map(latest.roles.map(role => [role.id, role]))
  for (const id of new Set([...previous.keys(), ...changes.keys()])) {
    const role = rebaseFields(previous.get(id), changes.get(id), roles.get(id))
    if (!role) return
    if (role.value) roles.set(id, role.value)
    else roles.delete(id)
  }
  const teamsEdited = !dequal(before.teams, edited.teams)
  if (teamsEdited && !dequal(before.teams, latest.teams) && !dequal(edited.teams, latest.teams))
    return
  return {
    ...latest,
    primary: primary.value,
    roles: [...roles.values()],
    teams: teamsEdited ? edited.teams : latest.teams,
  }
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
  let definitionConflict:
    | { cause: unknown; revision: string | undefined; baseline?: PersonalStandInSettings }
    | undefined
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
        const conflictResolved =
          definitionConflict &&
          data.settings.cloudDefinitionRevision !== definitionConflict.revision
        if (resetRevision === editRevision && (!definitionConflict || conflictResolved)) {
          draft = undefined
          definitionConflict = undefined
        } else if (conflictResolved && definitionConflict && draft) {
          const baseline = definitionConflict.baseline
          const rebased = baseline && rebaseRetainedDraft(baseline, draft, data.settings)
          if (rebased) {
            draft = rebased
            definitionConflict = undefined
          }
          // Overlapping edits retain the draft and conflict until an explicit discard/reload.
        } else if (conflictResolved) definitionConflict = undefined
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
          definitionConflict = {
            cause,
            revision: value.cloudDefinitionRevision,
            baseline:
              loaded.settings.cloudDefinitionRevision === value.cloudDefinitionRevision &&
              loaded.settings.version === value.version
                ? loaded.settings
                : undefined,
          }
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
