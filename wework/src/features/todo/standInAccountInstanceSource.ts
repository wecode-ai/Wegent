import type {
  PersonalAssistantAccount,
  PersonalAssistantStopIntent,
} from '@/api/personalAssistantAccount'
import { ApiError } from '@/api/http'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type {
  StandInBindingTarget,
  StandInExecutorApi,
  StandInInstanceBinding,
} from '@/api/standIn'
import { LOCAL_USER } from '@/api/local/localSession'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { isCloudDevice, isRemoteDevice, isRemoteTaskDevice } from '@/lib/device-capabilities'
import {
  findWorkbenchDevice,
  getWorkbenchDeviceIds,
  isLocalWorkbenchDeviceAlias,
} from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'
import {
  migrateStandIn,
  StandInMigrationError,
  StandInMigrationSourceUnavailable,
} from './migrateStandIn'
import { isStandInDeviceUnreachable, requiresStandInUpgrade } from '@/lib/stand-in-error-message'
import { resolveStandInEntry, type StandInEntry } from './standInEntry'
import {
  activateStandInBinding,
  cancelStandInActivation,
  completeStandInActivation,
  getStandInAccountStopIntent,
  hasSavedStandIn,
  localStopGeneration,
  sameTarget,
  type InstanceSnapshot,
  type InstanceObservation,
} from './standInLocalInstanceSource'
import { availableStandInDevices } from './standInDevices'

const accountAccessDeniedOrMissing = (cause: unknown) =>
  cause instanceof ApiError && [401, 403, 404].includes(cause.status)

export const isLocalDesktopDeviceId = (deviceId: string) =>
  isLocalWorkbenchDeviceAlias(deviceId) || deviceId.trim().startsWith('electron-')

export const normalizeStandInBindingTarget = (
  target: StandInBindingTarget,
  localDeviceId: string,
  devices: DeviceInfo[] = []
): StandInBindingTarget =>
  !localDeviceId ||
  target.deviceId === localDeviceId ||
  (target.userId !== LOCAL_USER.id &&
    (!isLocalDesktopDeviceId(target.deviceId) ||
      Boolean(findWorkbenchDevice(devices, target.deviceId))))
    ? target
    : { ...target, deviceId: localDeviceId }

export function resolveReachableStandInDevice(
  candidate: string | undefined,
  localDeviceId: string,
  devices: DeviceInfo[]
): string | undefined {
  const trimmed = candidate?.trim()
  if (!trimmed) return undefined
  if (localDeviceId && (trimmed === localDeviceId || isLocalWorkbenchDeviceAlias(trimmed))) {
    return localDeviceId
  }
  const matched = findWorkbenchDevice(devices, trimmed)
  if (!matched) {
    return !isLocalDesktopDeviceId(trimmed) ? trimmed : undefined
  }
  if (matched.device_type === 'local') return localDeviceId || matched.device_id
  if (isCloudDevice(matched) || isRemoteDevice(matched) || isRemoteTaskDevice(matched)) {
    return matched.device_id
  }
  return undefined
}

export function configuredPrimaryStandInDevice(
  account: PersonalAssistantAccount | undefined
): string | undefined {
  return account?.definitions
    .find(entry => entry.roleId === '@primary')
    ?.bot.spec?.execution_policy?.environment_id?.trim()
}

export async function resolvePrimaryStandInDevice({
  api,
  account,
  userId,
  localDeviceId,
  devices,
  connected,
  initialDeviceId,
}: {
  api: StandInExecutorApi
  account?: PersonalAssistantAccount
  userId: number
  localDeviceId: string
  devices: DeviceInfo[]
  connected: boolean
  initialDeviceId?: string
}): Promise<string> {
  const configured = configuredPrimaryStandInDevice(account)
  const reachable = resolveReachableStandInDevice(configured, localDeviceId, devices)
  if (reachable) return reachable
  const routeDevice = resolveReachableStandInDevice(initialDeviceId, localDeviceId, devices)
  if (routeDevice) return routeDevice
  const owned = await api.personalGet(userId, localDeviceId, { deviceSettingsOnly: true })
  if (hasSavedStandIn(owned)) return localDeviceId
  const available = connected ? availableStandInDevices(devices) : []
  const preferred = available.find(device => device.is_default) ?? available[0]
  return preferred?.device_id ?? localDeviceId
}

/** Resolve the account's primary execution device and manage per-device stand-in lifecycle. */
export function createAccountStandInInstanceSource({
  services,
  api,
  userId,
  backendUrl,
  initialDeviceId,
  requireSetupConfirmation = true,
  accountNavigationOnly = false,
}: {
  services: WorkbenchServices
  api: StandInExecutorApi | undefined
  userId: number
  backendUrl: string
  initialDeviceId?: string
  requireSetupConfirmation?: boolean
  accountNavigationOnly?: boolean
}) {
  let snapshot: InstanceSnapshot = { localDeviceId: '', busy: false, error: null }
  const listeners = new Set<() => void>()
  let observation: InstanceObservation | undefined
  let pinnedSelection: { userId: number; scope: string; deviceId: string } | undefined
  let verifiedProfile:
    | { target: StandInBindingTarget; profile: PersonalStandInSettings }
    | undefined
  let version = 0
  let readRevision = 0
  let activation = 0
  let lifetime = 0
  let refreshAfterMutation = false
  let stopping = false
  let setupSelection:
    | { target: StandInBindingTarget; configuredDevice?: string; entry?: StandInEntry }
    | undefined
  let activating:
    | { version: number; target: StandInBindingTarget; result: Promise<StandInInstanceBinding> }
    | undefined
  let abandonedActivation: { deviceId: string; binding: StandInInstanceBinding } | undefined
  let pendingSetup: Promise<void> | undefined
  const publish = (patch: Partial<InstanceSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const publishBinding = (binding: StandInInstanceBinding) =>
    publish({
      binding,
      ...(binding.status !== 'unbound' ? { setupTarget: undefined, entryFailure: undefined } : {}),
      ...(binding.status !== 'stopped' || !sameTarget(snapshot.binding?.target, binding.target)
        ? { stoppedProfile: undefined }
        : {}),
    })
  const invalidateAccountBinding = (
    cause: unknown,
    fallback: NonNullable<InstanceSnapshot['error']>['fallback']
  ) => {
    pinnedSelection = undefined
    verifiedProfile = undefined
    setupSelection = undefined
    publish({
      binding: undefined,
      stoppedProfile: undefined,
      setupTarget: undefined,
      entryFailure: undefined,
      error: { cause, fallback },
    })
  }
  const retireAbandonedActivation = async (
    localDeviceId: string,
    binding: StandInInstanceBinding
  ) => {
    const abandoned = abandonedActivation
    if (abandoned?.deviceId !== localDeviceId) return binding
    if (
      binding.status === 'activating' &&
      binding.version === abandoned.binding.version &&
      sameTarget(binding.target, abandoned.binding.target)
    ) {
      binding = await cancelStandInActivation(api!, localDeviceId, binding)
    }
    if (abandonedActivation === abandoned) abandonedActivation = undefined
    return binding
  }
  const selectionScope = (
    configured: string | undefined,
    localDeviceId: string,
    devices: DeviceInfo[]
  ) =>
    JSON.stringify([
      userId,
      configured ?? '',
      localDeviceId,
      resolveReachableStandInDevice(configured, localDeviceId, devices) ?? '',
    ])
  const profileFor = (target: StandInBindingTarget) =>
    verifiedProfile && sameTarget(verifiedProfile.target, target)
      ? verifiedProfile.profile
      : undefined
  const verifiedStatus = (target: StandInBindingTarget): StandInInstanceBinding['status'] => {
    const profile = profileFor(target)
    return profile ? (profile.lifecycle?.status ?? 'active') : 'unavailable'
  }
  const publishReadFailure = (
    target: StandInBindingTarget,
    pendingStop: boolean,
    cause: unknown
  ) => {
    const status = pendingStop ? 'stopping' : verifiedStatus(target)
    publishBinding({ version: ++version, status, target })
    publish({
      ...(status === 'stopped' ? { stoppedProfile: profileFor(target) } : {}),
      error: { cause, fallback: 'load_settings_failed' },
    })
  }
  const observed = (revision: number, deviceId?: string) =>
    listeners.size > 0 &&
    lifetime === revision &&
    (!deviceId || snapshot.localDeviceId === deviceId)
  const assertObserved = (revision: number, deviceId: string) => {
    if (!observed(revision, deviceId))
      throw new DOMException('Stand-in instance owner changed', 'AbortError')
  }
  const updateCloudPrimaryDevice = async (deviceId: string) => {
    const currentAccount = observation?.readAccount?.() ?? observation?.account
    const publishNextAccount = observation?.publishAccount
    const cloud = services.personalAssistantAccountApi
    if (!currentAccount || !publishNextAccount || !cloud) return
    if (configuredPrimaryStandInDevice(currentAccount) === deviceId) return
    const definitions = currentAccount.definitions.map(entry => ({
      roleId: entry.roleId,
      name: entry.team.metadata.displayName ?? entry.bot.metadata.displayName ?? '',
      prompt: entry.ghost.spec.systemPrompt,
      executionDeviceId:
        entry.roleId === '@primary' ? deviceId : entry.bot.spec?.execution_policy?.environment_id,
    }))
    try {
      publishNextAccount(await cloud.updateDefinitions(currentAccount.revision, definitions))
    } catch (cause) {
      const latest = await cloud.get?.().catch(() => null)
      if (latest) {
        publishNextAccount(latest)
        if (configuredPrimaryStandInDevice(latest) === deviceId) return
      }
      throw cause
    }
  }
  const markLocalStoppingTarget = async (localDeviceId: string, target: StandInBindingTarget) => {
    if (!api) throw new Error('Executor identity is unavailable')
    const saved = await api.binding(localDeviceId, 'markStoppingWithGeneration', undefined, target)
    const generation = localStopGeneration(saved, target)
    if (!generation) throw new Error('Executor did not record a stop marker generation')
    return generation
  }
  const stopDeviceIds = (deviceId: string) => {
    const device = findWorkbenchDevice(observation?.devices ?? [], deviceId)
    return device ? getWorkbenchDeviceIds(device) : [deviceId]
  }
  const sharedStopIntent = (account: PersonalAssistantAccount | undefined, deviceId: string) => {
    return getStandInAccountStopIntent(account, deviceId, observation?.devices ?? [])
  }
  const loadStopAccount = async () => {
    const cloud = services.personalAssistantAccountApi
    if (userId === LOCAL_USER.id || !cloud || !observation?.account) return undefined
    const account = await cloud.get()
    if (!account) throw new ApiError('Personal assistant account is unavailable', 404)
    return account
  }
  const clearStopIntent = async (
    localDeviceId: string,
    target: StandInBindingTarget,
    localPending: number | undefined,
    sharedPending?: PersonalAssistantStopIntent
  ) => {
    if (localPending !== undefined)
      await api!.binding(localDeviceId, 'clearStoppingIfGeneration', localPending, target)
    if (sharedPending) {
      await services.personalAssistantAccountApi!.updateStopIntent(
        sharedPending.deviceId,
        'clear',
        sharedPending.requestId
      )
    }
  }
  const read = async (preserveMutationError = true) => {
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
      // A new subscriber must not adopt a durable preparation while its previous
      // owner is still deciding whether to activate or cancel it.
      if (pendingSetup) {
        await pendingSetup
        if (!current()) return
      }
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity || !api) throw new Error('Executor identity is unavailable')
      if (current()) {
        if (snapshot.localDeviceId && snapshot.localDeviceId !== identity.deviceId) {
          pinnedSelection = undefined
          verifiedProfile = undefined
        }
        publish({
          localDeviceId: identity.deviceId,
          ...(snapshot.localDeviceId && snapshot.localDeviceId !== identity.deviceId
            ? {
                binding: undefined,
                stoppedProfile: undefined,
                setupTarget: undefined,
                entryFailure: undefined,
              }
            : {}),
        })
      }
      const { account: stopAccount, error: accountError } = await loadStopAccount().then(
        account => ({ account, error: null }),
        (cause: unknown) => ({
          account: undefined,
          error: { cause, fallback: 'load_settings_failed' as const },
        })
      )
      if (!current()) return
      if (accountError && accountAccessDeniedOrMissing(accountError.cause)) {
        invalidateAccountBinding(accountError.cause, accountError.fallback)
        return
      }
      const observedAccount = owner.readAccount?.() ?? owner.account
      const activeAccount = stopAccount ?? observedAccount
      if (
        stopAccount &&
        (stopAccount.revision !== observedAccount?.revision ||
          configuredPrimaryStandInDevice(stopAccount) !==
            configuredPrimaryStandInDevice(observedAccount))
      ) {
        owner.publishAccount?.(stopAccount)
      }
      const configured = configuredPrimaryStandInDevice(activeAccount)
      if (accountNavigationOnly && !configured) {
        pinnedSelection = undefined
        verifiedProfile = undefined
        setupSelection = undefined
        publish({
          binding: { version: ++version, status: 'unbound', target: null },
          stoppedProfile: undefined,
          setupTarget: undefined,
          entryFailure: undefined,
          error: accountError,
        })
        return
      }
      const scope = selectionScope(configured, identity.deviceId, owner.devices)
      let targetDeviceId: string
      if (pinnedSelection?.userId === userId && pinnedSelection.scope === scope) {
        targetDeviceId = pinnedSelection.deviceId
      } else {
        targetDeviceId = await resolvePrimaryStandInDevice({
          api,
          account: activeAccount,
          userId,
          localDeviceId: identity.deviceId,
          devices: owner.devices,
          connected: owner.connected,
          initialDeviceId,
        })
        if (!current()) return
        pinnedSelection = { userId, scope, deviceId: targetDeviceId }
      }
      const target: StandInBindingTarget = {
        userId,
        backendUrl: userId === LOCAL_USER.id ? '' : backendUrl,
        deviceId: targetDeviceId,
      }
      const mutationError =
        preserveMutationError &&
        sameTarget(snapshot.binding?.target, target) &&
        snapshot.error?.fallback === 'save_settings_failed'
          ? snapshot.error
          : null
      const savedBinding = await api.binding(identity.deviceId, 'get')
      if (!current()) return
      const nativeBinding = await retireAbandonedActivation(identity.deviceId, savedBinding)
      if (!current()) return
      const localPending = localStopGeneration(nativeBinding, target)
      const sharedPending = sharedStopIntent(stopAccount, targetDeviceId)
      const pendingStop =
        localPending !== undefined ||
        Boolean(sharedPending) ||
        (accountError !== null &&
          snapshot.binding?.status === 'stopping' &&
          sameTarget(snapshot.binding.target, target))
      if (!current()) return
      if (accountError !== null && targetDeviceId !== identity.deviceId) {
        publishReadFailure(target, pendingStop, accountError.cause)
        return
      }
      if (findWorkbenchDevice(owner.devices, targetDeviceId)?.status === 'offline') {
        publishReadFailure(
          target,
          pendingStop,
          Object.assign(new Error('Device offline'), { code: 'device_offline' })
        )
        return
      }
      let profile: PersonalStandInSettings
      try {
        profile = await api.personalGet(userId, targetDeviceId, { deviceSettingsOnly: true })
      } catch (cause) {
        if (current()) publishReadFailure(target, pendingStop, cause)
        return
      }
      if (!current()) return
      verifiedProfile = { target, profile }
      const lifecycleStatus = profile.lifecycle?.status
      if (lifecycleStatus === 'stopped') {
        publishBinding({ version: ++version, status: 'stopped', target })
        publish({ stoppedProfile: profile, error: accountError ?? mutationError })
        if (pendingStop && current() && (sharedPending?.expectedVersion ?? 0) <= profile.version)
          await clearStopIntent(identity.deviceId, target, localPending, sharedPending)
        return
      }
      // Only the explicitly confirmed first activation uses the durable local binding.
      // Its target must still match the account, and a pending stop always takes priority.
      if (
        !accountNavigationOnly &&
        !pendingStop &&
        lifecycleStatus !== 'stopping' &&
        !accountError
      ) {
        if (nativeBinding.status === 'activating' && sameTarget(nativeBinding.target, target)) {
          const latest = await loadStopAccount()
          if (!current()) return
          if (latest && configuredPrimaryStandInDevice(latest) !== configured) {
            owner.publishAccount?.(latest)
            pinnedSelection = undefined
            return
          }
          if (sharedStopIntent(latest, target.deviceId)) {
            publishBinding({ version: ++version, status: 'stopping', target })
            return
          }
          publishBinding({ ...nativeBinding, version: ++version })
          if (
            activating?.version !== nativeBinding.version ||
            !sameTarget(activating.target, target)
          ) {
            // A recovered preparation never needs a new start when the
            // target profile has already been verified as active.
            const result = completeStandInActivation(api, identity.deviceId, nativeBinding).finally(
              () => {
                if (activating?.result === result) activating = undefined
              }
            )
            activating = { version: nativeBinding.version, target, result }
          }
          await activating.result
          if (!current()) return
        } else if (
          nativeBinding.status === 'unbound' &&
          (owner.newAccount ||
            (setupSelection &&
              sameTarget(setupSelection.target, target) &&
              setupSelection.configuredDevice === configured) ||
            (requireSetupConfirmation &&
              targetDeviceId === identity.deviceId &&
              !hasSavedStandIn(profile)))
        ) {
          publishBinding({ version: ++version, status: 'unbound', target: null })
          const entry = owner.entry
          setupSelection = { target, configuredDevice: configured, entry }
          if (entry && entry.kind !== 'home') {
            publish({ setupTarget: undefined, entryFailure: undefined, error: null })
            if (entry.kind !== 'identity') return
            const resolved = await resolveStandInEntry(
              owner.entryApi ?? api,
              entry,
              target,
              new Set([
                identity.deviceId,
                ...(owner.connected
                  ? availableStandInDevices(owner.devices).map(device => device.device_id)
                  : []),
              ]),
              { unbound: true }
            )
            if (!current()) return
            if (resolved.kind === 'error') {
              publish({ entryFailure: { entry, error: resolved.error } })
              return
            }
            if (resolved.deviceId !== target.deviceId) {
              publish({ entryFailure: { entry, error: 'conflict' } })
              return
            }
            if (requireSetupConfirmation) return
          }
          publish({ setupTarget: setupSelection.target, entryFailure: undefined, error: null })
          if (!requireSetupConfirmation) await mutate('setup', {})
          return
        }
      }
      setupSelection = undefined
      const status = lifecycleStatus === 'stopping' || pendingStop ? 'stopping' : 'active'
      publishBinding({ version: ++version, status, target })
      publish({ error: accountError ?? mutationError })
    } catch (cause) {
      if (current()) publish({ error: { cause, fallback: 'load_settings_failed' } })
    }
  }
  const mutate = async (
    operation: 'setup' | 'stop' | 'bind' | 'migrate' | 'initialize',
    input: {
      version?: number
      initializeTarget?(): Promise<void>
      target?: StandInBindingTarget
      roleId?: string
      primaryName?: string
      targetApi?: StandInExecutorApi
    }
  ) => {
    const owner = observation
    if (!listeners.size || !owner?.active || snapshot.busy || pendingSetup) return
    const binding = snapshot.binding
    const localDeviceId = snapshot.localDeviceId
    const revision = lifetime
    readRevision++
    activation++
    stopping = operation === 'stop'
    publish({ busy: true, error: null })
    let finishSetup: (() => void) | undefined
    try {
      if (operation === 'setup') {
        pendingSetup = new Promise<void>(resolve => {
          finishSetup = resolve
        })
        if (accountNavigationOnly) return
        const selection = setupSelection
        const target = snapshot.setupTarget
        if (
          !api ||
          !localDeviceId ||
          binding?.status !== 'unbound' ||
          !target ||
          !selection ||
          !sameTarget(selection.target, target)
        )
          return
        const mayActivate = () =>
          observed(revision, localDeviceId) &&
          observation?.active &&
          observation.entry === selection.entry &&
          observation.connected === ownerConnected &&
          (target.deviceId === localDeviceId ||
            (observation.connected &&
              availableStandInDevices(observation.devices).some(
                device => device.device_id === target.deviceId
              )))
        const ownerConnected = owner.connected
        const profile = await api.personalGet(target.userId, target.deviceId, {
          deviceSettingsOnly: true,
        })
        const latest = await loadStopAccount()
        if (!mayActivate()) return
        if (configuredPrimaryStandInDevice(latest) !== selection.configuredDevice) {
          if (latest) observation?.publishAccount?.(latest)
          pinnedSelection = undefined
          setupSelection = undefined
          refreshAfterMutation = true
          throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
        }
        const nativeBinding = await api.binding(localDeviceId, 'get')
        if (!mayActivate()) return
        if (
          nativeBinding.status !== 'unbound' ||
          localStopGeneration(nativeBinding, target) !== undefined ||
          sharedStopIntent(latest, target.deviceId)
        ) {
          refreshAfterMutation = true
          throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
        }
        const prepared = await api.binding(
          localDeviceId,
          'prepareBind',
          nativeBinding.version,
          target
        )
        if (prepared.status !== 'activating' || !sameTarget(prepared.target, target))
          throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
        abandonedActivation = { deviceId: localDeviceId, binding: prepared }
        try {
          if (!mayActivate()) return
          const confirmedAccount = await loadStopAccount()
          if (!mayActivate()) return
          if (
            configuredPrimaryStandInDevice(confirmedAccount) !== selection.configuredDevice ||
            sharedStopIntent(confirmedAccount, target.deviceId)
          ) {
            if (confirmedAccount) observation?.publishAccount?.(confirmedAccount)
            return
          }
          abandonedActivation = undefined
          publishBinding({ ...prepared, version: ++version })
          const ready = await activateStandInBinding(api, localDeviceId, prepared, profile.version)
          assertObserved(revision, localDeviceId)
          setupSelection = undefined
          publishBinding({ ...ready, version: ++version })
        } finally {
          if (abandonedActivation) {
            setupSelection = undefined
            refreshAfterMutation = true
            await retireAbandonedActivation(localDeviceId, prepared)
          }
        }
        return
      }
      if (operation === 'stop') {
        const expectedTarget = input.target ?? binding?.target
        if (!api || !binding?.target || !expectedTarget || !localDeviceId) return
        if (
          !sameTarget(binding.target, expectedTarget) ||
          (input.version !== undefined && binding.version !== input.version)
        ) {
          throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
        }
        // This is the profile observed when the user confirmed this target. It
        // must never be replaced with a profile read after the stop is recorded.
        const confirmedProfile = profileFor(expectedTarget)
        const latest = await loadStopAccount().catch(cause => {
          if (expectedTarget.deviceId !== localDeviceId || accountAccessDeniedOrMissing(cause))
            throw cause
          return undefined
        })
        if (latest && binding.status !== 'stopping') {
          assertObserved(revision, localDeviceId)
          const latestReachable = resolveReachableStandInDevice(
            configuredPrimaryStandInDevice(latest),
            localDeviceId,
            observation?.devices ?? []
          )
          if (latestReachable && latestReachable !== expectedTarget.deviceId) {
            observation?.publishAccount?.(latest)
            pinnedSelection = undefined
            refreshAfterMutation = true
            throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
          }
        }
        const target = expectedTarget
        if (target.deviceId !== localDeviceId && !latest)
          throw new Error('Personal assistant account is unavailable')
        let localPending = localStopGeneration(await api.binding(localDeviceId, 'get'), target)
        assertObserved(revision, localDeviceId)
        let sharedPending = sharedStopIntent(latest, target.deviceId)
        const remoteStop = Boolean(latest && target.deviceId !== localDeviceId)
        if (remoteStop) {
          const expectedRequestId =
            stopDeviceIds(target.deviceId)
              .map(id => latest?.stopIntentGenerations?.[id])
              .find(id => id !== undefined) ?? null
          const expectedVersion = confirmedProfile?.version ?? sharedPending?.expectedVersion
          const requestId =
            sharedPending && sharedPending.expectedVersion === expectedVersion
              ? sharedPending.requestId
              : crypto.randomUUID()
          const marked = await services
            .personalAssistantAccountApi!.updateStopIntent(
              target.deviceId,
              'mark',
              requestId,
              expectedRequestId,
              expectedVersion
            )
            .catch(cause => {
              if (cause instanceof ApiError && cause.status === 409) refreshAfterMutation = true
              throw cause
            })
          sharedPending = sharedStopIntent(marked, target.deviceId)
          if (
            !sharedPending ||
            sharedPending.requestId !== requestId ||
            sharedPending.expectedVersion !== expectedVersion
          ) {
            refreshAfterMutation = true
            throw new Error('Personal assistant stop request is no longer pending')
          }
        } else {
          localPending = await markLocalStoppingTarget(localDeviceId, target)
        }
        assertObserved(revision, localDeviceId)
        publishBinding({ version: ++version, status: 'stopping', target })
        let stopped: PersonalStandInSettings
        if (remoteStop && sharedPending) {
          // An unreachable target may have no verified version. Record its
          // pending intent and let a later explicit retry confirm a new version.
          if (!confirmedProfile || sharedPending.expectedVersion !== confirmedProfile.version) {
            refreshAfterMutation = true
            return
          }
          const confirmed = sharedStopIntent(await loadStopAccount(), target.deviceId)
          assertObserved(revision, localDeviceId)
          if (
            confirmed?.requestId !== sharedPending.requestId ||
            confirmed.expectedVersion !== sharedPending.expectedVersion
          ) {
            refreshAfterMutation = true
            throw Object.assign(new Error('Stop request changed'), { code: 'version_conflict' })
          }
          stopped =
            confirmedProfile.lifecycle?.status === 'stopped'
              ? confirmedProfile
              : await api.lifecycle(
                  target.userId,
                  target.deviceId,
                  'stop',
                  sharedPending.expectedVersion
                )
        } else {
          stopped = await api.lifecycle(target.userId, target.deviceId, 'stop')
        }
        assertObserved(revision, localDeviceId)
        if (stopped.lifecycle?.status !== 'stopped') {
          throw Object.assign(new Error('Stand-in cancellation is incomplete'), {
            code: 'stand_in_stop_incomplete',
          })
        }
        if (observed(revision, localDeviceId)) {
          verifiedProfile = { target, profile: stopped }
          publishBinding({ version: ++version, status: 'stopped', target })
          publish({ stoppedProfile: stopped })
        }
        await clearStopIntent(localDeviceId, target, localPending, sharedPending)
        return
      }
      if (!api || !localDeviceId || !input.target) {
        if (operation === 'migrate' || operation === 'initialize')
          throw new StandInMigrationError('not_stopped')
        return
      }
      const target = normalizeStandInBindingTarget(
        input.target,
        localDeviceId,
        observation?.devices
      )
      const localPending = localStopGeneration(await api.binding(localDeviceId, 'get'), target)
      assertObserved(revision, localDeviceId)
      if (target.userId !== userId) throw new StandInMigrationError('not_stopped')
      let role: Awaited<ReturnType<typeof migrateStandIn>> | 'initialized' | undefined
      if (operation === 'initialize') role = 'initialized'
      if (operation === 'migrate') {
        const source = binding?.target
        if (!source) throw new StandInMigrationError('not_stopped')
        if (source.deviceId === target.deviceId) throw new StandInMigrationError('same_device')
        if (binding.status !== 'stopped') {
          if (!input.initializeTarget) throw new StandInMigrationError('not_stopped')
          // A direct device switch never cancels the old device. When the source
          // cannot be migrated, the explicit recovery action selects a fresh destination.
          if (binding.status === 'stopping') role = 'initialized'
          else {
            try {
              const profile = await api.personalGet(source.userId, source.deviceId, {
                deviceSettingsOnly: true,
              })
              if (profile.lifecycle?.status !== 'stopped')
                throw new StandInMigrationError('not_stopped')
            } catch (cause) {
              if (!isStandInDeviceUnreachable(cause) && !requiresStandInUpgrade(cause)) throw cause
              role = 'initialized'
            }
          }
        }
        if (!role) {
          try {
            role = await migrateStandIn(api, {
              sourceUser: source.userId,
              sourceDevice: source.deviceId,
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
            role = 'initialized'
          }
        }
      }
      assertObserved(revision, localDeviceId)
      await updateCloudPrimaryDevice(target.deviceId)
      assertObserved(revision, localDeviceId)
      pinnedSelection = {
        userId: target.userId,
        scope: selectionScope(
          configuredPrimaryStandInDevice(observation?.readAccount?.() ?? observation?.account),
          localDeviceId,
          observation?.devices ?? []
        ),
        deviceId: target.deviceId,
      }
      let status = verifiedStatus(target)
      try {
        // Observe the target before the account marker. The Executor checks this
        // version atomically, so a stop completed between the marker read and
        // start cannot be unintentionally reversed.
        const profile = await api.personalGet(target.userId, target.deviceId, {
          deviceSettingsOnly: true,
        })
        assertObserved(revision, localDeviceId)
        verifiedProfile = { target, profile }
        status = verifiedStatus(target)
        const latest = await loadStopAccount()
        assertObserved(revision, localDeviceId)
        if (target.deviceId !== localDeviceId && !latest)
          throw new Error('Personal assistant account is unavailable')
        if (latest && configuredPrimaryStandInDevice(latest) !== target.deviceId) {
          observation?.publishAccount?.(latest)
          pinnedSelection = undefined
          throw Object.assign(new Error('version conflict'), { code: 'version_conflict' })
        }
        const sharedPending = sharedStopIntent(latest, target.deviceId)
        const pendingStop = localPending !== undefined || Boolean(sharedPending)
        if (pendingStop) {
          // A recorded stop can still be pending when the remote device is online again.
          // Selecting that device must not restart it or discard the stop request.
          status = 'stopping'
          if (
            profile.lifecycle?.status !== 'stopped' ||
            (sharedPending?.expectedVersion ?? 0) > profile.version
          )
            return role
          await clearStopIntent(localDeviceId, target, localPending, sharedPending)
          assertObserved(revision, localDeviceId)
          if (sharedStopIntent(await loadStopAccount(), target.deviceId)) return role
          status = 'stopped'
        }
        const started = await api.lifecycle(
          target.userId,
          target.deviceId,
          'start',
          profile.version
        )
        if (started.lifecycle?.status) throw new Error('Stand-in start was not confirmed')
        assertObserved(revision, localDeviceId)
        verifiedProfile = { target, profile: started }
        status = 'active'
        if (observed(revision, localDeviceId)) return role
      } finally {
        if (observed(revision, localDeviceId)) {
          publishBinding({ version: ++version, status, target })
          if (status === 'stopped') publish({ stoppedProfile: profileFor(target) })
        }
      }
    } catch (cause) {
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        (cause.code === 'version_conflict' || cause.code === 'stand_in_stop_incomplete')
      )
        refreshAfterMutation = true
      if (observed(revision, localDeviceId))
        publish({ error: { cause, fallback: 'save_settings_failed' } })
      if (operation === 'migrate' || operation === 'bind' || operation === 'initialize') throw cause
    } finally {
      if (finishSetup) {
        pendingSetup = undefined
        finishSetup()
      }
      if (observed(revision, localDeviceId)) {
        stopping = false
        const setupScopeChanged =
          operation === 'setup' &&
          (owner.entry !== observation?.entry ||
            owner.connected !== observation?.connected ||
            owner.devices !== observation?.devices)
        publish({ busy: false, ...(setupScopeChanged ? { setupTarget: undefined } : {}) })
        if (refreshAfterMutation || setupScopeChanged) {
          refreshAfterMutation = false
          void read()
        }
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(owner: InstanceObservation, listener: () => void) {
      const previous = observation
      observation = owner
      listeners.add(listener)
      const targetId = snapshot.binding?.target?.deviceId
      const stopStateChanged =
        targetId !== undefined &&
        sharedStopIntent(previous?.account, targetId)?.requestId !==
          sharedStopIntent(owner.account, targetId)?.requestId
      const configuredDeviceChanged =
        configuredPrimaryStandInDevice(previous?.account) !==
        configuredPrimaryStandInDevice(owner.account)
      const changed =
        !previous ||
        previous.active !== owner.active ||
        previous.connected !== owner.connected ||
        previous.devices !== owner.devices ||
        previous.entry !== owner.entry ||
        previous.entryApi !== owner.entryApi ||
        previous.newAccount !== owner.newAccount ||
        previous.entryRequestKey !== owner.entryRequestKey ||
        configuredDeviceChanged ||
        stopStateChanged
      if (!previous || previous.active !== owner.active || previous.entry !== owner.entry)
        activation++
      if (changed) {
        readRevision++
        if (owner.active && !snapshot.busy) void read()
        else if (owner.active && (stopStateChanged || (stopping && configuredDeviceChanged)))
          refreshAfterMutation = true
      }
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size) return
          readRevision++
          lifetime++
          activation++
          observation = undefined
          refreshAfterMutation = false
          stopping = false
          publish({ busy: false })
        })
      }
    },
    stop: async (targetOrVersion?: StandInBindingTarget | number, expectedVersion?: number) => {
      await mutate(
        'stop',
        typeof targetOrVersion === 'number'
          ? { version: targetOrVersion }
          : { target: targetOrVersion, version: expectedVersion }
      )
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
      void read(false)
    },
  }
}
