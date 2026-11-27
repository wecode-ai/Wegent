import { ApiError } from '@/api/http'
import { LOCAL_USER } from '@/api/local/localSession'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { Button } from '@/components/ui/button'
import { invalidatesExperienceRead } from '@/features/collaboration-exp/data/useExperienceSourceReads'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type { CloudWorkCheckStatus } from '@/types/workbench'
import { findWorkbenchDevice, isLocalWorkbenchDeviceAlias } from '@/lib/workbench-device'
import {
  getStandInErrorMessage,
  isStandInDeviceUnreachable,
  reportStandInError,
} from '@/lib/stand-in-error-message'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  hasSavedStandIn,
  initializeStandInTarget,
  isLocalDesktopDeviceId,
  normalizeStandInBindingTarget,
} from './standInInstanceSource'
import { initializePersonalAssistantOnDevice } from './personalAssistantDeviceSettings'
import { resolveStandInEntry, type StandInEntry } from './standInEntry'
import { availableStandInDevices } from './standInDevices'

interface SetupObservation {
  preferredDevice?: string
  initialEntry?: StandInEntry
  devices: DeviceInfo[]
  deviceCatalogStatus: CloudWorkCheckStatus
}

interface SetupData {
  account: PersonalAssistantAccount | null
  local?: PersonalStandInSettings
  newAccount: boolean
  waitingForCatalog?: boolean
}

const waitForCatalog: SetupData = { account: null, newAccount: false, waitingForCatalog: true }
const catalogPending = (status: CloudWorkCheckStatus) => status === 'idle' || status === 'syncing'
const explicitPrimaryEntry = (entry: StandInEntry | undefined) =>
  entry?.kind === 'identity' && entry.profileId === '@primary' && entry.deviceId
    ? { ...entry, deviceId: entry.deviceId }
    : undefined

async function verifyInitialEntryDevice(
  api: StandInExecutorApi,
  observation: SetupObservation,
  localDeviceId: string,
  userId: number,
  signal: AbortSignal,
  localProfile?: PersonalStandInSettings
): Promise<string | null | undefined> {
  const explicit = explicitPrimaryEntry(observation.initialEntry)
  if (!explicit) return undefined
  if (explicit.userId && explicit.userId !== String(userId))
    throw Object.assign(new Error(), { code: 'permission_denied' })
  const requested = explicit.deviceId
  if (requested === localDeviceId && localProfile) {
    if (localProfile.userId !== userId || localProfile.executionDeviceId !== requested)
      throw Object.assign(new Error(), { code: 'permission_denied' })
    return requested
  }
  if (requested !== localDeviceId) {
    if (observation.deviceCatalogStatus === 'unavailable')
      throw Object.assign(new Error(), { code: 'cloud_unavailable' })
    if (
      !availableStandInDevices(observation.devices).some(device => device.device_id === requested)
    ) {
      if (catalogPending(observation.deviceCatalogStatus)) return null
      throw Object.assign(new Error(), { code: 'executor_unavailable' })
    }
  }
  const result = await resolveStandInEntry(
    api,
    explicit,
    { userId, deviceId: requested },
    new Set([requested]),
    { unbound: true }
  )
  signal.throwIfAborted()
  if (result.kind !== 'ready')
    throw Object.assign(new Error(), {
      code: result.error === 'forbidden' ? 'permission_denied' : 'executor_unavailable',
    })
  return result.deviceId
}

async function loadSetup(
  services: WorkbenchServices,
  userId: number,
  name: string,
  signal: AbortSignal,
  readObservation: () => SetupObservation
): Promise<SetupData> {
  if (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true')
    performance.mark('wework:assistant-account-load')
  const cloud = services.personalAssistantAccountApi!
  const account = await cloud.get(signal).catch((cause: unknown) => {
    signal.throwIfAborted()
    reportStandInError('load_cloud_assistant', cause)
    if (cause instanceof ApiError && cause.status === 404)
      throw new Error('cloud_assistant_api_unavailable', { cause })
    throw new Error(getStandInErrorMessage(cause, 'load_cloud_assistant_failed'), { cause })
  })
  if (account) return { account, local: undefined, newAccount: false }
  signal.throwIfAborted()
  const requestedEntry = explicitPrimaryEntry(readObservation().initialEntry)
  if (requestedEntry?.userId && requestedEntry.userId !== String(userId))
    throw Object.assign(new Error(), { code: 'permission_denied' })
  const api = services.standInApi
  if (!services.getLocalRuntimeSidebarIdentity || !api) {
    if (requestedEntry) throw Object.assign(new Error(), { code: 'executor_unavailable' })
    return { account: await cloud.initialize(name), local: undefined, newAccount: true }
  }
  const device = await services.getLocalRuntimeSidebarIdentity()
  if (!device) throw new Error('Executor identity is unavailable')
  const binding = await api.binding(device.deviceId)
  const observed = readObservation()
  const savedTarget = binding.target
  if (
    savedTarget?.userId === userId &&
    savedTarget.deviceId !== device.deviceId &&
    isLocalDesktopDeviceId(savedTarget.deviceId) &&
    !isLocalWorkbenchDeviceAlias(savedTarget.deviceId) &&
    !findWorkbenchDevice(observed.devices, savedTarget.deviceId)
  ) {
    // Distinguishing a registered peer from a legacy desktop alias requires a catalog result.
    if (catalogPending(observed.deviceCatalogStatus)) return waitForCatalog
    if (observed.deviceCatalogStatus === 'unavailable')
      throw Object.assign(new Error(), { code: 'cloud_unavailable' })
  }
  const target = binding.target
    ? normalizeStandInBindingTarget(binding.target, device.deviceId, observed.devices)
    : null
  signal.throwIfAborted()
  if (
    target &&
    (target.userId === userId ||
      (target.userId === LOCAL_USER.id && target.deviceId === device.deviceId))
  ) {
    let profile
    try {
      profile = await api.personalGet(target.userId, target.deviceId)
    } catch (cause) {
      signal.throwIfAborted()
      if (!isStandInDeviceUnreachable(cause) || target.deviceId === device.deviceId) throw cause
      const latest = readObservation()
      const entryDevice = await verifyInitialEntryDevice(
        api,
        latest,
        device.deviceId,
        userId,
        signal
      )
      signal.throwIfAborted()
      if (entryDevice === null) return waitForCatalog
      if (entryDevice === target.deviceId) throw cause
      const targetDevice =
        entryDevice ??
        (latest.preferredDevice && latest.preferredDevice !== target.deviceId
          ? latest.preferredDevice
          : device.deviceId)
      const account = await initializeStandInTarget(
        api,
        device.deviceId,
        binding,
        { userId, deviceId: targetDevice, backendUrl: target.backendUrl },
        async () => {
          signal.throwIfAborted()
          return initializePersonalAssistantOnDevice(cloud, name, targetDevice)
        }
      )
      return { account, local: undefined, newAccount: false }
    }
    signal.throwIfAborted()
    if (hasSavedStandIn(profile)) return { account: null, local: profile, newAccount: false }
    const explicit = explicitPrimaryEntry(readObservation().initialEntry)
    if (
      explicit &&
      (explicit.deviceId !== target.deviceId ||
        profile.userId !== target.userId ||
        profile.executionDeviceId !== target.deviceId)
    )
      throw Object.assign(new Error(), { code: 'permission_denied' })
    return {
      account: await cloud.initialize(name, undefined, target.deviceId),
      local: undefined,
      newAccount: false,
    }
  }
  const [owned, local] = await Promise.all([
    api.personalGet(userId, device.deviceId),
    api.personalGet(LOCAL_USER.id, device.deviceId),
  ])
  signal.throwIfAborted()
  const legacy = hasSavedStandIn(owned) ? owned : hasSavedStandIn(local) ? local : undefined
  if (legacy) return { account: null, local: legacy, newAccount: false }

  const entryDevice = await verifyInitialEntryDevice(
    api,
    readObservation(),
    device.deviceId,
    userId,
    signal,
    owned
  )
  signal.throwIfAborted()
  if (entryDevice === null) return waitForCatalog
  const initialDevice = entryDevice ?? readObservation().preferredDevice ?? device.deviceId
  return {
    account: await cloud.initialize(name, undefined, initialDevice),
    local: undefined,
    newAccount: true,
  }
}

export function PersonalAssistantAccountSetup({
  services,
  userId,
  active,
  preferredDevice,
  initialEntry,
  devices = [],
  deviceCatalogStatus = 'unavailable',
  children,
}: {
  services: WorkbenchServices
  userId: number
  active: boolean
  preferredDevice?: string
  initialEntry?: StandInEntry
  devices?: DeviceInfo[]
  deviceCatalogStatus?: CloudWorkCheckStatus
  children(
    account: PersonalAssistantAccount | undefined,
    publish: (account: PersonalAssistantAccount) => void,
    readAccount: () => PersonalAssistantAccount | undefined,
    reloadAccount?: () => void,
    newAccount?: boolean
  ): ReactNode
}) {
  const { t } = useTranslation('common')
  const name = t('standIn.personal.default_role')
  const readObservation = useStableEvent(() => ({
    preferredDevice,
    initialEntry,
    devices,
    deviceCatalogStatus,
  }))
  const load = useStableEvent((signal: AbortSignal) =>
    loadSetup(services, userId, name, signal, readObservation)
  )
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([userId]), load, {
        refreshOnSubscribe: true,
      }),
    [userId, load]
  )
  const entry = explicitPrimaryEntry(initialEntry)
  const pendingCatalog = catalogPending(deviceCatalogStatus)
  const waiting = resource.getSnapshot().data?.waitingForCatalog
  const [observedCatalog, setObservedCatalog] = useState<typeof resource>()
  // Once a legacy binding has waited for the catalog, retain that observation key
  // after its profile arrives so the successful read does not trigger another load.
  const observeLegacyCatalog =
    observedCatalog === resource || (!entry && waiting && !pendingCatalog)
  if (observeLegacyCatalog && observedCatalog !== resource) setObservedCatalog(resource)
  const entryAvailable =
    entry && availableStandInDevices(devices).some(device => device.device_id === entry.deviceId)
  const catalogState =
    entryAvailable && deviceCatalogStatus !== 'unavailable'
      ? 'candidate'
      : pendingCatalog
        ? 'pending'
        : deviceCatalogStatus
  const catalogVersion =
    entry || observeLegacyCatalog
      ? JSON.stringify([entry?.userId, entry?.deviceId, catalogState])
      : ''
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, catalogVersion),
    [resource, catalogVersion]
  )
  const snapshot = useSyncExternalStore(
    active ? subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const [confirmation, setConfirmation] = useState(true)
  const [pending, setPending] = useState(false)
  const [migrationNotice, setMigrationNotice] = useState(false)
  const clearMigrationNotice = useCallback(() => setMigrationNotice(false), [])
  const [error, setError] = useState<unknown>()
  const inFlight = useRef(false)
  const publish = useCallback(
    (account: PersonalAssistantAccount) => {
      if (!invalidatesExperienceRead(resource.getSnapshot().error))
        resource.update(() => ({ account, local: undefined, newAccount: false }))
    },
    [resource]
  )
  const readAccount = useCallback(() => {
    const current = resource.getSnapshot()
    return invalidatesExperienceRead(current.error)
      ? undefined
      : (current.data?.account ?? undefined)
  }, [resource])
  const reloadAccount = useCallback(() => {
    void resource.reload()
  }, [resource])
  const data = snapshot.data
  const failure = snapshot.error ?? error
  const retry = failure ? (
    <>
      <p role="alert" className="text-sm text-error">
        {getStandInErrorMessage(failure, 'load_settings_failed')}
      </p>
      <Button
        data-testid="personal-assistant-account-retry"
        onClick={() => {
          setError(undefined)
          reloadAccount()
        }}
      >
        {t('standIn.reload')}
      </Button>
    </>
  ) : null
  if (data?.account && !invalidatesExperienceRead(snapshot.error)) {
    return (
      <>
        {retry && (
          <section
            className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2"
            data-testid="personal-assistant-account-refresh-error"
          >
            {retry}
          </section>
        )}
        {children(data.account, publish, readAccount, reloadAccount, data.newAccount)}
        <TransientNotice
          message={migrationNotice ? t('standIn.account.migration_complete') : null}
          onClear={clearMigrationNotice}
          tone="success"
          visible={active}
        />
      </>
    )
  }

  const initialize = async () => {
    if (!data?.local || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    try {
      const source = data.local
      const local = await services.standInApi!.personalGet(source.userId, source.executionDeviceId)
      const account = await services.personalAssistantAccountApi!.initialize(name, local)
      setMigrationNotice(Boolean(local))
      publish(account)
    } catch (cause) {
      setError(cause)
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <>
      <section
        className={
          data?.local && !failure
            ? 'flex flex-wrap items-center gap-2 border-b border-border px-5 py-2'
            : 'space-y-3 p-5'
        }
        data-testid="personal-assistant-account-setup"
      >
        {failure ? (
          retry
        ) : data?.local ? (
          <>
            <span className="text-sm text-text-secondary">
              {t('standIn.account.local_profile')}
            </span>
            <Button
              size="sm"
              variant="outline"
              data-testid="personal-assistant-account-initialize"
              disabled={pending}
              onClick={() => setConfirmation(true)}
            >
              {t('standIn.account.migrate')}
            </Button>
          </>
        ) : (
          <p role="status" className="text-sm">
            {t('standIn.loading')}
          </p>
        )}
        <ConfirmDialog
          open={active && !!data?.local && confirmation && !failure}
          title={t('standIn.account.migrate')}
          description={t('standIn.account.migrate_description')}
          cancelLabel={t('standIn.account.later')}
          confirmLabel={t('standIn.account.migrate')}
          confirmTestId="personal-assistant-account-migrate-confirm"
          cancelTestId="personal-assistant-account-migrate-cancel"
          pending={pending}
          onClose={() => {
            setConfirmation(false)
          }}
          onConfirm={() => void initialize()}
        />
      </section>
    </>
  )
}
