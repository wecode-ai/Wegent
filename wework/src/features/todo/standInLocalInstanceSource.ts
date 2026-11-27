import {
  isStandInBindingOwner,
  type StandInBindingTarget,
  type StandInInstanceBinding,
  type StandInExecutorApi,
} from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { LOCAL_USER } from '@/api/local/localSession'
import { availableStandInDevices } from './standInDevices'
import { resolveStandInEntry, type StandInEntry, type StandInEntryError } from './standInEntry'
import {
  migrateStandIn,
  StandInMigrationError,
  StandInMigrationSourceUnavailable,
} from './migrateStandIn'
import { raceWithTimeout } from '@/lib/promise-timeout'
import {
  isStandInDeviceUnreachable,
  reportStandInError,
  requiresStandInUpgrade,
} from '@/lib/stand-in-error-message'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'

export interface InstanceSnapshot {
  binding?: StandInInstanceBinding
  setupTarget?: StandInBindingTarget
  entryFailure?: { entry: StandInEntry; error: StandInEntryError }
  stoppedProfile?: PersonalStandInSettings
  localDeviceId: string
  busy: boolean
  error: { cause: unknown; fallback: 'load_settings_failed' | 'save_settings_failed' } | null
}
export interface InstanceObservation {
  account?: PersonalAssistantAccount
  newAccount?: boolean
  publishAccount?: (account: PersonalAssistantAccount) => void
  readAccount?: () => PersonalAssistantAccount | undefined
  devices: DeviceInfo[]
  connected: boolean
  active: boolean
  entryRequestKey?: number
  entry?: StandInEntry
  entryApi?: Pick<StandInExecutorApi, 'personalGet'>
}
export const hasSavedStandIn = (settings: PersonalStandInSettings) =>
  Boolean(
    settings.version > 0 ||
    settings.roles.some(
      role =>
        role.version > 0 || role.enabled || role.name || role.prompt || role.connections?.length
    ) ||
    settings.primary?.prompt ||
    settings.primary?.preferences
  )
export const sameTarget = (
  left: StandInBindingTarget | null | undefined,
  right: StandInBindingTarget | null | undefined
) => left?.userId === right?.userId && left?.deviceId === right?.deviceId

export async function activateStandInBinding(
  api: StandInExecutorApi,
  localDeviceId: string,
  binding: StandInInstanceBinding,
  expectedVersion?: number
) {
  const target = binding.target!
  if (expectedVersion === undefined) await api.lifecycle(target.userId, target.deviceId, 'start')
  else await api.lifecycle(target.userId, target.deviceId, 'start', expectedVersion)
  try {
    return await api.binding(localDeviceId, 'completeActivation', binding.version)
  } catch (cause) {
    const saved = await api.binding(localDeviceId)
    if (saved.status === 'active' && sameTarget(saved.target, target)) return saved
    throw cause
  }
}

export async function initializeStandInTarget<T>(
  api: StandInExecutorApi,
  localDeviceId: string,
  binding: StandInInstanceBinding,
  target: StandInBindingTarget,
  initializeAccount: () => Promise<T>,
  onBound?: (binding: StandInInstanceBinding) => void
) {
  const settings = await api.personalGet(target.userId, target.deviceId)
  if (settings.lifecycle?.status === 'stopping') throw new StandInMigrationError('not_stopped')
  const account = await initializeAccount()
  const next = await api.binding(
    localDeviceId,
    binding.status === 'stopped' ? 'prepareBind' : 'prepareReplacement',
    binding.version,
    target
  )
  onBound?.(next)
  const ready = await activateStandInBinding(api, localDeviceId, next)
  onBound?.(ready)
  return account
}

/** The local instance binding owns initialization, cancellation and rebind transactions. */
export function createLocalStandInInstanceSource({
  services,
  api,
  userId,
  backendUrl,
  requireSetupConfirmation = true,
}: {
  services: WorkbenchServices
  api: StandInExecutorApi | undefined
  userId: number
  backendUrl: string
  requireSetupConfirmation?: boolean
}) {
  let snapshot: InstanceSnapshot = { localDeviceId: '', busy: false, error: null }
  const listeners = new Set<() => void>()
  let observation: InstanceObservation | undefined
  let readRevision = 0
  let activation = 0
  let lifetime = 0
  let activating:
    | { deviceId: string; version: number; result: Promise<StandInInstanceBinding> }
    | undefined
  const publish = (patch: Partial<InstanceSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const publishBinding = (binding: StandInInstanceBinding) =>
    publish({
      binding,
      ...(binding.status !== 'unbound' ? { setupTarget: undefined, entryFailure: undefined } : {}),
      ...(binding.status !== 'stopped' ||
      binding.version !== snapshot.binding?.version ||
      !sameTarget(snapshot.binding?.target, binding.target) ||
      (binding.target && !isStandInBindingOwner(binding.target.userId, userId))
        ? { stoppedProfile: undefined }
        : {}),
    })
  const observed = (revision: number, deviceId?: string) =>
    listeners.size > 0 &&
    lifetime === revision &&
    (!deviceId || snapshot.localDeviceId === deviceId)
  const assertObserved = (revision: number, deviceId: string) => {
    if (!observed(revision, deviceId))
      throw new DOMException('Stand-in instance owner changed', 'AbortError')
  }
  const discoverSetupTarget = async (deviceId: string, owner: InstanceObservation) => {
    const owned = await api!.personalGet(userId, deviceId)
    const available = owner.connected ? availableStandInDevices(owner.devices) : []
    const preferred = available.find(device => device.is_default) ?? available[0]
    return setupBindingTarget(
      hasSavedStandIn(owned) ? deviceId : (preferred?.device_id ?? deviceId)
    )
  }
  const setupBindingTarget = (deviceId: string): StandInBindingTarget => ({
    userId,
    backendUrl: userId === LOCAL_USER.id ? '' : backendUrl,
    deviceId,
  })
  const resolveSetupEntry = (
    deviceId: string,
    owner: InstanceObservation,
    entry: Extract<StandInEntry, { kind: 'identity' }>
  ) =>
    resolveStandInEntry(
      owner.entryApi ?? api!,
      entry,
      { userId, deviceId: entry.deviceId ?? deviceId },
      new Set([
        deviceId,
        ...(owner.connected
          ? availableStandInDevices(owner.devices).map(device => device.device_id)
          : []),
      ]),
      { unbound: true }
    )
  const initialize = async (
    deviceId: string,
    unbound: StandInInstanceBinding,
    target: StandInBindingTarget,
    epoch: number,
    revision: number
  ) => {
    const mayBind = () =>
      observed(revision, deviceId) &&
      observation?.active &&
      activation === epoch &&
      (target.deviceId === deviceId ||
        (observation.connected &&
          availableStandInDevices(observation.devices).some(
            device => device.device_id === target.deviceId
          )))
    if (!mayBind()) return { binding: unbound }
    if (target.deviceId !== deviceId) {
      await api!.personalGet(target.userId, target.deviceId)
      if (!mayBind()) return { binding: unbound }
    }
    let bound: StandInInstanceBinding
    try {
      bound = await api!.binding(deviceId, 'prepareBind', unbound.version, target)
    } catch (cause) {
      if (
        !cause ||
        typeof cause !== 'object' ||
        !('code' in cause) ||
        cause.code !== 'version_conflict'
      )
        throw cause
      // A competing initializer owns its target; never start it on this transaction's behalf.
      return { binding: await api!.binding(deviceId) }
    }
    if (!observed(revision, deviceId)) return { binding: bound }
    try {
      return { binding: await activateStandInBinding(api!, deviceId, bound) }
    } catch (error) {
      return { binding: bound, error }
    }
  }
  const read = async () => {
    const owner = observation
    if (!owner?.active || !listeners.size || snapshot.busy) return
    const revision = ++readRevision
    const epoch = activation
    const ownerRevision = lifetime
    const current = () =>
      observed(ownerRevision) &&
      observation?.active &&
      epoch === activation &&
      revision === readRevision
    try {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity || !api) throw new Error('Executor identity is unavailable')
      if (current())
        publish({
          localDeviceId: identity.deviceId,
          ...(snapshot.localDeviceId && snapshot.localDeviceId !== identity.deviceId
            ? { binding: undefined, stoppedProfile: undefined, setupTarget: undefined }
            : {}),
        })
      let binding = await api.binding(identity.deviceId)
      if (!current()) return
      if (binding.status === 'unbound') {
        publishBinding(binding)
        const entry = owner.entry
        if (entry && entry.kind !== 'home') {
          publish({ setupTarget: undefined, entryFailure: undefined, error: null })
          if (requireSetupConfirmation || entry.kind !== 'identity') return
          const resolved = await resolveSetupEntry(identity.deviceId, owner, entry)
          if (!current()) return
          if (resolved.kind === 'error') {
            publish({ entryFailure: { entry, error: resolved.error } })
            return
          }
          publish({ setupTarget: setupBindingTarget(resolved.deviceId) })
          await mutate('setup', {})
          return
        }
        if (snapshot.setupTarget) return
        const setupTarget = await discoverSetupTarget(identity.deviceId, owner)
        if (!current()) return
        publish({ setupTarget, entryFailure: undefined, error: null })
        if (!requireSetupConfirmation) await mutate('setup', {})
        return
      }
      if (
        binding.status === 'stopped' &&
        binding.target &&
        isStandInBindingOwner(binding.target.userId, userId)
      ) {
        // Binding choices remain usable while the stopped device profile is loading.
        publishBinding(binding)
        const stoppedProfile = await api.personalGet(binding.target.userId, binding.target.deviceId)
        if (current()) publish({ stoppedProfile, error: null })
        return
      }
      if (
        binding.status === 'activating' &&
        binding.target &&
        isStandInBindingOwner(binding.target.userId, userId)
      ) {
        publishBinding(binding)
        if (activating?.deviceId !== identity.deviceId || activating.version !== binding.version) {
          const result = activateStandInBinding(api, identity.deviceId, binding).finally(() => {
            if (activating?.result === result) activating = undefined
          })
          activating = { deviceId: identity.deviceId, version: binding.version, result }
        }
        binding = await activating.result
      }
      if (current()) {
        publishBinding(binding)
        publish({ error: null })
      }
    } catch (cause) {
      if (current()) publish({ error: { cause, fallback: 'load_settings_failed' } })
    }
  }
  const mutate = async (
    operation: 'setup' | 'stop' | 'bind' | 'migrate' | 'initialize',
    input: {
      version?: number
      target?: StandInBindingTarget
      roleId?: string
      primaryName?: string
      targetApi?: StandInExecutorApi
      initializeTarget?(): Promise<void>
    }
  ) => {
    const owner = observation
    if (!listeners.size || !owner?.active || snapshot.busy) return
    const binding = snapshot.binding
    const localDeviceId = snapshot.localDeviceId
    const revision = lifetime
    publish({ busy: true, error: null })
    try {
      if (operation === 'setup') {
        const target = snapshot.setupTarget
        if (!api || !localDeviceId || binding?.status !== 'unbound' || !target) return
        readRevision++
        const result = await initialize(localDeviceId, binding, target, ++activation, revision)
        if (observed(revision, localDeviceId)) {
          publishBinding(result.binding)
          if (result.error) throw result.error
        }
        return
      }
      if (!api || !binding || !localDeviceId) return
      const source = binding.target
      const ownsSource = source && isStandInBindingOwner(source.userId, userId)
      const target = input.target
      if (operation === 'stop' && (!ownsSource || binding.status === 'stopped')) return
      if (operation === 'bind' && binding.status !== 'stopped') return
      if (operation === 'migrate' || operation === 'initialize') {
        if (!ownsSource || !target || binding.status === 'unbound')
          throw new StandInMigrationError('not_stopped')
        if (source.deviceId === target.deviceId) throw new StandInMigrationError('same_device')
      }
      readRevision++
      activation++
      let current = binding
      const initializeDestination = async () => {
        if (!target || !input.initializeTarget) throw new StandInMigrationError('not_stopped')
        assertObserved(revision, localDeviceId)
        await initializeStandInTarget(
          api,
          localDeviceId,
          current,
          target,
          async () => {
            assertObserved(revision, localDeviceId)
            await input.initializeTarget!()
            assertObserved(revision, localDeviceId)
          },
          next => {
            if (observed(revision, localDeviceId)) publishBinding(next)
          }
        )
        return 'initialized' as const
      }
      if (operation !== 'bind' && source && binding.status !== 'stopped') {
        current = await api.binding(localDeviceId, 'beginStop', input.version ?? binding.version)
        assertObserved(revision, localDeviceId)
        publishBinding(current)
        let stopped
        try {
          stopped = await raceWithTimeout(
            api.lifecycle(source.userId, source.deviceId, 'stop'),
            operation === 'initialize' ? 15_000 : undefined,
            () =>
              Object.assign(new Error('Stopping the source device timed out'), {
                code: 'runtime_rpc_timeout',
              })
          )
          if (stopped.lifecycle?.status !== 'stopped')
            throw Object.assign(new Error('Stand-in cancellation is incomplete'), {
              code: 'stand_in_stop_incomplete',
            })
        } catch (cause) {
          reportStandInError('stop-instance', cause, source.deviceId)
          const stopIncomplete =
            cause &&
            typeof cause === 'object' &&
            'code' in cause &&
            cause.code === 'stand_in_stop_incomplete'
          if (
            !target ||
            !input.initializeTarget ||
            !(stopIncomplete || isStandInDeviceUnreachable(cause) || requiresStandInUpgrade(cause))
          )
            throw cause
          return await initializeDestination()
        }
        assertObserved(revision, localDeviceId)
        current = await api.binding(localDeviceId, 'completeStop', current.version)
        assertObserved(revision, localDeviceId)
        publishBinding(current)
        publish({ stoppedProfile: stopped })
      }
      if (operation === 'initialize') return await initializeDestination()
      if (operation === 'stop' || !target) return
      let role
      if (operation === 'migrate') {
        try {
          role = await migrateStandIn(api, {
            sourceUser: source!.userId,
            sourceDevice: source!.deviceId,
            roleId: input.roleId,
            targetUser: target.userId,
            targetDevice: target.deviceId,
            primaryName: input.primaryName!,
            targetApi: input.targetApi,
            assertOwnership: () => assertObserved(revision, localDeviceId),
          })
        } catch (cause) {
          if (!(cause instanceof StandInMigrationSourceUnavailable) || !input.initializeTarget)
            throw cause
          return await initializeDestination()
        }
      }
      assertObserved(revision, localDeviceId)
      const next = await api.binding(localDeviceId, 'prepareBind', current.version, target)
      assertObserved(revision, localDeviceId)
      publishBinding(next)
      const ready = await activateStandInBinding(api, localDeviceId, next)
      if (observed(revision, localDeviceId)) {
        publishBinding(ready)
        return role
      }
    } catch (cause) {
      if (observed(revision, localDeviceId) && !(cause instanceof StandInMigrationError))
        publish({ error: { cause, fallback: 'save_settings_failed' } })
      if (operation === 'migrate' || operation === 'initialize') throw cause
    } finally {
      if (observed(revision, localDeviceId)) {
        const setupScopeChanged =
          operation === 'setup' &&
          (owner.entry !== observation?.entry ||
            owner.connected !== observation?.connected ||
            owner.devices !== observation?.devices)
        publish({ busy: false, ...(setupScopeChanged ? { setupTarget: undefined } : {}) })
        if (setupScopeChanged) void read()
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(owner: InstanceObservation, listener: () => void) {
      const previous = observation
      observation = owner
      listeners.add(listener)
      const changed =
        !previous ||
        previous.active !== owner.active ||
        previous.connected !== owner.connected ||
        previous.devices !== owner.devices ||
        previous.entry !== owner.entry ||
        previous.entryApi !== owner.entryApi ||
        previous.entryRequestKey !== owner.entryRequestKey
      if (!previous || previous.active !== owner.active || previous.entry !== owner.entry)
        activation++
      if (changed) {
        readRevision++
        if (owner.active && !snapshot.busy) void read()
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          readRevision++
          lifetime++
          activation++
          observation = undefined
          publish({ busy: false })
        })
      }
    },
    stop: async (targetOrVersion?: StandInBindingTarget | number, expectedVersion?: number) => {
      const binding = snapshot.binding
      if (typeof targetOrVersion === 'object' && !sameTarget(targetOrVersion, binding?.target)) {
        publish({
          error: {
            cause: Object.assign(new Error('version conflict'), { code: 'version_conflict' }),
            fallback: 'save_settings_failed',
          },
        })
        return
      }
      await mutate('stop', {
        version:
          typeof targetOrVersion === 'number'
            ? targetOrVersion
            : (expectedVersion ?? binding?.version),
      })
    },
    setup: async () => {
      const target = snapshot.setupTarget
      await mutate('setup', {})
      return (
        !snapshot.error &&
        snapshot.binding?.status === 'active' &&
        sameTarget(snapshot.binding.target, target)
      )
    },
    bind: async (target: StandInBindingTarget) => {
      await mutate('bind', { target })
    },
    migrate: (
      target: StandInBindingTarget,
      roleId: string | undefined,
      primaryName: string,
      targetApi?: StandInExecutorApi,
      initializeTarget?: () => Promise<void>
    ) => mutate('migrate', { target, roleId, primaryName, targetApi, initializeTarget }),
    initializeOnDevice: (target: StandInBindingTarget, initializeTarget: () => Promise<void>) =>
      mutate('initialize', { target, initializeTarget }),
    reload: () => {
      void read()
    },
  }
}
