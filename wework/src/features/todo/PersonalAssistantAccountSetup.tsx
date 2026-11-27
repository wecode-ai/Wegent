import { ApiError } from '@/api/http'
import { LOCAL_USER } from '@/api/local/localSession'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { Button } from '@/components/ui/button'
import { invalidatesExperienceRead } from '@/features/collaboration-exp/data/useExperienceSourceReads'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
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
  normalizeStandInBindingTarget,
} from './standInInstanceSource'
import { initializePersonalAssistantOnDevice } from './personalAssistantDeviceSettings'
import { resolveStandInEntry, type StandInEntry } from './standInEntry'
import { availableStandInDevices } from './standInDevices'

async function loadSetup(
  services: WorkbenchServices,
  userId: number,
  name: string,
  signal: AbortSignal,
  preferredDevice?: string,
  initialEntry?: StandInEntry,
  devices: DeviceInfo[] = []
) {
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
  const api = services.standInApi
  if (!services.getLocalRuntimeSidebarIdentity || !api) {
    return { account: await cloud.initialize(name), local: undefined, newAccount: true }
  }
  const device = await services.getLocalRuntimeSidebarIdentity()
  if (!device) throw new Error('Executor identity is unavailable')
  const binding = await api.binding(device.deviceId)
  const target = binding.target
    ? normalizeStandInBindingTarget(binding.target, device.deviceId, devices)
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
      const targetDevice =
        preferredDevice && preferredDevice !== target.deviceId ? preferredDevice : device.deviceId
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

  let initialDevice = preferredDevice ?? device.deviceId
  if (
    initialEntry?.kind === 'identity' &&
    initialEntry.profileId === '@primary' &&
    initialEntry.deviceId &&
    (!initialEntry.userId || initialEntry.userId === String(userId))
  ) {
    const requested = initialEntry.deviceId
    if (
      requested === device.deviceId &&
      owned.userId === userId &&
      owned.executionDeviceId === requested
    ) {
      initialDevice = requested
    } else if (availableStandInDevices(devices).some(device => device.device_id === requested)) {
      const result = await resolveStandInEntry(
        api,
        initialEntry,
        { userId, deviceId: requested },
        new Set([requested]),
        { unbound: true }
      )
      signal.throwIfAborted()
      if (result.kind === 'ready') initialDevice = result.deviceId
    }
  }
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
  devices,
  children,
}: {
  services: WorkbenchServices
  userId: number
  active: boolean
  preferredDevice?: string
  initialEntry?: StandInEntry
  devices?: DeviceInfo[]
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
  const load = useStableEvent((signal: AbortSignal) =>
    loadSetup(services, userId, name, signal, preferredDevice, initialEntry, devices)
  )
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([userId]), load, {
        refreshOnSubscribe: true,
      }),
    [userId, load]
  )
  const snapshot = useSyncExternalStore(
    active ? resource.subscribe : subscribeIdleResource,
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
    if (!data || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    try {
      const source = data.local
      const local = source
        ? await services.standInApi!.personalGet(source.userId, source.executionDeviceId)
        : undefined
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
        ) : data ? (
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
