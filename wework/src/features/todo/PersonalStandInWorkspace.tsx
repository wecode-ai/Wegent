import { StandInCloudConnectionPrompt } from './StandInCloudConnectionPrompt'
import { LOCAL_USER } from '@/api/local/localSession'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { isStandInBindingOwner, type StandInBindingTarget } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TransientNotice } from '@/components/common/TransientNotice'
import { Button } from '@/components/ui/button'
import { Tooltip } from '@/components/ui/tooltip'
import { CircleStop } from 'lucide-react'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { CollaborationExpErrorBoundary } from '@/features/collaboration-exp/CollaborationExpRoute'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { useTranslation } from '@/hooks/useTranslation'
import {
  navigateTo,
  WORKSPACE_NAVIGATION_EVENT,
  type WorkspaceNavigationDetail,
} from '@/lib/navigation'
import { getStandInErrorMessage, requiresStandInUpgrade } from '@/lib/stand-in-error-message'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { findWorkbenchDevice, getWorkbenchDeviceIds } from '@/lib/workbench-device'
import type { DeviceInfo, RuntimeTaskAddress, User } from '@/types/api'
import type { CollaborationProject } from '@wegent/collaboration'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { dequal } from 'dequal'
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { StandInMigrationError } from './migrateStandIn'
import { PersonalAssistantAccountSetup } from './PersonalAssistantAccountSetup'
import {
  collectPersonalAssistantDefinitionBackups,
  initializePersonalAssistantOnDevice,
  personalAssistantDeviceSettings,
  resolveAssistantExecutionDevice,
} from './personalAssistantDeviceSettings'
import { createPersonalStandInWorkspaceSource } from './personalStandInWorkspaceSource'
import { availableStandInDevices } from './standInDevices'
import { getStandInAccountStopIntent, localStopGeneration } from './standInLocalInstanceSource'
import { parseStandInEntry, type StandInEntryError } from './standInEntry'
import { StandInHomeSetup } from './StandInHomeSetup'
import { StandInHomeWorkspace } from './StandInHomeWorkspace'
import { StandInMigration } from './StandInMigration'
import { StandInOverviewPage } from './StandInOverviewPage'
import { StandInRouteFailure, StandInRouteLoading } from './StandInRouteState'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { useStandInEntry } from './useStandInEntry'
import { useStandInInstance } from './useStandInInstance'
import { useStandInRoleDirectory } from './useStandInRoleDirectory'
import type { PersonalHomeCollaborationWork } from './WeworkPersonalHome'
import { createWeworkPlatformApi } from './weworkPlatformApi'

type PersonalStandInWorkspaceProps = {
  services: WorkbenchServices
  user: User
  devices: DeviceInfo[]
  active: boolean
  contentRoute: string
  entryRequestKey?: number
  onClose(): void
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  embedded?: boolean
  homeProjects?: CollaborationProject[]
  collaborationWork?: PersonalHomeCollaborationWork
  experienceEnabled?: boolean
}

const loadAssistantWorkspace = () =>
  import('@/features/collaboration-exp/assistant/AssistantWorkspace')

export function PersonalStandInWorkspace(props: PersonalStandInWorkspaceProps) {
  const cloud = useContext(CloudConnectionContext)
  const workbench = useContext(WorkbenchContext)
  if (!cloud?.isConnected || !cloud.user) return <StandInCloudConnectionPrompt />
  const key = JSON.stringify([cloud?.apiBaseUrl ?? '', props.user.id])
  if (
    cloud?.isConnected &&
    cloud.user?.id === props.user.id &&
    props.user.id !== LOCAL_USER.id &&
    props.services.personalAssistantAccountApi
  ) {
    const available = availableStandInDevices(props.devices)
    return (
      <PersonalAssistantAccountSetup
        preferredDevice={(available.find(device => device.is_default) ?? available[0])?.device_id}
        initialEntry={parseStandInEntry(props.contentRoute)}
        devices={props.devices}
        deviceCatalogStatus={workbench?.cloudWorkStatus?.checks.devices ?? 'unavailable'}
        key={key}
        services={props.services}
        userId={Number(props.user.id)}
        active={props.active}
      >
        {(account, publishAccount, readAccount) => (
          <AccountStandInWorkspace
            {...props}
            account={account}
            publishAccount={publishAccount}
            readAccount={readAccount}
          />
        )}
      </PersonalAssistantAccountSetup>
    )
  }
  return <StandInCloudConnectionPrompt />
}

/** Use the account definition for navigation and keep legacy recovery local to this page. */
function AccountStandInWorkspace({
  services,
  user,
  devices,
  active,
  contentRoute,
  entryRequestKey,
  onClose,
  onOpenTask,
  embedded = false,
  homeProjects = [],
  collaborationWork,
  experienceEnabled = false,
  account,
  publishAccount,
  readAccount,
}: PersonalStandInWorkspaceProps & {
  account?: PersonalAssistantAccount
  publishAccount?: (account: PersonalAssistantAccount) => void
  readAccount?: () => PersonalAssistantAccount | undefined
}) {
  const { t, i18n } = useTranslation('common')
  const { t: experienceT } = useTranslation('collaborationExp')
  const cloud = useContext(CloudConnectionContext)
  const [reentry, setReentry] = useState(0)
  const refreshKey = (entryRequestKey ?? 0) + reentry
  useDOMEvent<CustomEvent<WorkspaceNavigationDetail>>(
    'window',
    WORKSPACE_NAVIGATION_EVENT,
    event => {
      if (event.detail?.contentRoute === contentRoute) setReentry(current => current + 1)
    },
    { enabled: !embedded && active && contentRoute === '/stand-in' }
  )
  const [workspaceSource] = useState(createPersonalStandInWorkspaceSource)
  const userId = Number(user.id)
  const backendUrl = cloud?.apiBaseUrl ?? ''
  const legacyInstance = useStandInInstance(services, userId, devices, true, active, backendUrl, {
    entryRequestKey: refreshKey,
    legacyOnly: true,
  })
  const instance = useStandInInstance(services, userId, devices, true, active, backendUrl, {
    entryRequestKey: refreshKey,
    accountNavigationOnly: true,
    account,
    publishAccount,
    readAccount,
  })
  const { binding, busy } = instance
  const localDeviceId = instance.localDeviceId || legacyInstance.localDeviceId
  const legacyBinding = legacyInstance.binding
  const legacyTarget = legacyBinding?.target
  const ownerId = userId
  const target = binding?.target ?? undefined
  const deviceId = target?.deviceId
  const accountScope = JSON.stringify([userId, backendUrl, deviceId])
  const assistantDeviceKey = JSON.stringify(
    [
      ...new Set(
        [deviceId, localDeviceId, ...devices.flatMap(getWorkbenchDeviceIds)].filter(Boolean)
      ),
    ].sort()
  )
  const isKnownAssistantDevice = useMemo(() => {
    const known = new Set<string>(JSON.parse(assistantDeviceKey))
    return (id: string) => known.has(id)
  }, [assistantDeviceKey])
  const cloudAssistantServices = useMemo(
    () =>
      readAccount && publishAccount
        ? personalAssistantDeviceSettings(
            services,
            readAccount,
            publishAccount,
            backendUrl,
            isKnownAssistantDevice,
            deviceId
          )
        : services,
    [services, readAccount, publishAccount, backendUrl, isKnownAssistantDevice, deviceId]
  )
  const configuredDeviceOffline = findWorkbenchDevice(devices, deviceId)?.status === 'offline'
  const assistantServices = cloudAssistantServices
  const [experience, setExperience] = useState(() => ({
    revision: 0,
    Workspace: lazy(loadAssistantWorkspace),
  }))
  const AssistantWorkspace = experience.Workspace
  const overview = useRef<Pick<StandInSettingsHandle, 'requestLeave'>>(null)
  const connected = Boolean(cloud?.isConnected)
  const availableDevices = useMemo(
    () => (connected ? availableStandInDevices(devices) : []),
    [connected, devices]
  )
  const availableDeviceIds = useMemo(
    () => availableDevices.map(device => device.device_id),
    [availableDevices]
  )
  const authorizedDeviceIds = useMemo(() => {
    const ids = new Set(availableDeviceIds)
    if (localDeviceId) ids.add(localDeviceId)
    return ids
  }, [availableDeviceIds, localDeviceId])
  const verifiedStoppedPrimary =
    !embedded &&
    binding?.status === 'stopped' &&
    instance.stoppedProfile?.lifecycle?.status === 'stopped' &&
    instance.stoppedProfile.userId === ownerId &&
    instance.stoppedProfile.executionDeviceId === deviceId &&
    !instance.error
  const verifyIndependentDevice = useStableEvent(async (roleDeviceId: string, roleId: string) => {
    const cloudApi = services.personalAssistantAccountApi
    const executor = services.standInApi
    const observed = readAccount?.()
    if (!cloudApi || !executor || !localDeviceId || !connected || !observed) return false
    const [latest, native] = await Promise.all([
      cloudApi.get(),
      executor.binding(localDeviceId, 'get'),
    ])
    if (!latest || !dequal(readAccount?.(), observed)) return false
    if (
      latest.revision !== observed.revision ||
      !dequal(latest.stopIntents, observed.stopIntents) ||
      !dequal(latest.stopIntentGenerations, observed.stopIntentGenerations)
    ) {
      publishAccount?.(latest)
      return false
    }
    if (latest.retiredRoleIds.includes(roleId) || !deviceId) return false
    const definition = latest.definitions.find(value => value.roleId === roleId)
    if (
      definition &&
      resolveAssistantExecutionDevice(
        definition.bot.spec?.execution_policy?.environment_id,
        deviceId,
        deviceId,
        isKnownAssistantDevice
      ) !== roleDeviceId
    )
      return false
    return (
      !getStandInAccountStopIntent(latest, roleDeviceId, devices) &&
      localStopGeneration(native, { userId: ownerId, deviceId: roleDeviceId, backendUrl }) ===
        undefined
    )
  })
  const independentScope = verifiedStoppedPrimary
    ? JSON.stringify([
        binding.version,
        account?.revision,
        account?.stopIntents,
        account?.stopIntentGenerations,
      ])
    : undefined
  const {
    entry,
    result,
    retry: retryEntry,
  } = useStandInEntry(
    contentRoute,
    verifiedStoppedPrimary ? services.standInApi : assistantServices.standInApi,
    binding?.status === 'active' || verifiedStoppedPrimary ? target : undefined,
    authorizedDeviceIds,
    active && !embedded,
    entryRequestKey,
    verifiedStoppedPrimary ? verifyIndependentDevice : undefined,
    independentScope
  )
  let entryError: StandInEntryError | undefined
  if (entry.kind === 'error') entryError = entry.error
  else if (entry.kind !== 'home') {
    if (entry.userId && entry.userId !== String(ownerId)) entryError = 'forbidden'
    else if (instance.error && (!binding || binding.status === 'unavailable'))
      entryError = 'lookup_failed'
    else if (
      binding &&
      (!target ||
        (binding.status !== 'active' && !(verifiedStoppedPrimary && entry.kind === 'identity')))
    )
      entryError = 'not_found'
    else if (entry.kind === 'conversation' && !experienceEnabled) entryError = 'unsupported'
    else if (result?.kind === 'error') entryError = result.error
  }
  const entryLoading =
    entry.kind !== 'home' && (!binding || (entry.kind === 'identity' && result?.kind !== 'ready'))
  const verifiedRole = result?.kind === 'ready' ? result : undefined
  const independentRole = verifiedStoppedPrimary ? verifiedRole : undefined
  const settingsRequest = entry.kind === 'identity' ? entry.settingsRequest : undefined
  const scheduled = 'scheduled' in entry && entry.scheduled
  const routeLocation = useMemo(
    () =>
      !entryError && !entryLoading
        ? {
            key: JSON.stringify([contentRoute, entryRequestKey, accountScope]),
            location: verifiedRole
              ? {
                  deviceId: verifiedRole.deviceId,
                  roleId: verifiedRole.profileId,
                  settings: Boolean(settingsRequest),
                }
              : undefined,
          }
        : undefined,
    [
      entryError,
      entryLoading,
      contentRoute,
      entryRequestKey,
      accountScope,
      verifiedRole,
      settingsRequest,
    ]
  )
  const showAssistantExperience =
    experienceEnabled &&
    !embedded &&
    !scheduled &&
    !settingsRequest &&
    (entry.kind === 'home' ||
      entry.kind === 'conversation' ||
      verifiedRole?.profileId === '@primary')
  const api = useMemo(
    () =>
      createWeworkPlatformApi(
        services.sharedWorkspaceApi,
        createLocalWorkspaceApi(
          services.projectSpaceApis?.local,
          ownerId,
          user.user_name || 'local',
          user.email ?? null,
          services.projectSpaceDetailServices?.local,
          i18n.language === 'en' ? 'en' : 'zh-CN'
        )
      ),
    [services, ownerId, user.user_name, user.email, i18n.language]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      workspaceSource.subscribe(
        {
          api,
          accountScope,
          target,
          active,
          embedded,
          entry: routeLocation,
          requestLeave: action =>
            overview.current ? overview.current.requestLeave(action) : action(),
        },
        listener
      ),
    [workspaceSource, api, accountScope, target, active, embedded, routeLocation]
  )
  const view = useSyncExternalStore(
    subscribe,
    workspaceSource.getSnapshot,
    workspaceSource.getSnapshot
  )
  const requestedRoleLocation =
    !independentRole && view.entryKey === routeLocation?.key && view.selectionScope === accountScope
      ? view.roleLocation
      : routeLocation?.location
  const selectedDefinition = account?.definitions.find(
    entry => entry.roleId === requestedRoleLocation?.roleId
  )
  const roleLocation =
    !requestedRoleLocation ||
    selectedDefinition ||
    isKnownAssistantDevice(requestedRoleLocation.deviceId)
      ? requestedRoleLocation
      : undefined
  const selectedDevice = independentRole
    ? independentRole.deviceId
    : roleLocation?.roleId && roleLocation.roleId !== '@primary'
      ? selectedDefinition && deviceId
        ? resolveAssistantExecutionDevice(
            selectedDefinition.bot.spec?.execution_policy?.environment_id,
            deviceId,
            deviceId,
            isKnownAssistantDevice
          )
        : roleLocation.deviceId
      : deviceId
  const sameProjectOwner = view.projectsApi === api && view.projectsScope === accountScope
  const projects = sameProjectOwner ? view.projects : []
  const projectError = sameProjectOwner ? view.error : null
  const readLegacyRoles =
    legacyTarget &&
    isStandInBindingOwner(legacyTarget.userId, userId) &&
    (legacyBinding.status === 'stopping' ||
      (legacyTarget.userId === LOCAL_USER.id && legacyTarget.deviceId !== deviceId))
  const directory = useStandInRoleDirectory(
    assistantServices.standInApi,
    ownerId,
    deviceId,
    !embedded &&
      active &&
      !entryError &&
      !entryLoading &&
      !!binding &&
      (!showAssistantExperience || Boolean(readLegacyRoles)),
    localDeviceId,
    refreshKey,
    availableDeviceIds
  )
  const [confirmStop, setConfirmStop] = useState<{
    target: StandInBindingTarget
    version: number
  } | null>(null)
  const requestStop = () => {
    if (!target || !binding) return
    const confirm = () => setConfirmStop({ target, version: binding.version })
    if (overview.current) overview.current.requestLeave(confirm)
    else confirm()
  }
  const actions =
    target && binding ? (
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="stand-in-instance-stop"
        disabled={busy}
        className="ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-50 md:min-h-8"
        onClick={requestStop}
      >
        {t(binding.status === 'stopping' ? 'standIn.instance.retry_stop' : 'standIn.instance.stop')}
      </ControlButton>
    ) : undefined
  const deviceChoices = [
    ...(localDeviceId
      ? [{ userId, deviceId: localDeviceId, name: t('standIn.account_local_profile') }]
      : []),
    ...availableDevices.map(device => ({ userId, deviceId: device.device_id, name: device.name })),
  ]
  const alternateDevices = deviceChoices.filter(value => value.deviceId !== deviceId)
  const bindDevice = (device: string) => instance.bind({ userId, backendUrl, deviceId: device })
  const renderBindChoices = (choices: typeof deviceChoices) => (
    <div className="flex flex-wrap gap-2">
      {choices.map(value => (
        <ControlButton
          variant="outline"
          size="sm"
          key={`${value.userId}:${value.deviceId}`}
          type="button"
          data-testid={`stand-in-instance-bind-${value.userId}-${value.deviceId}`}
          disabled={busy}
          className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
          onClick={() => void bindDevice(value.deviceId).catch(() => {})}
        >
          {value.name}
        </ControlButton>
      ))}
    </div>
  )
  const [noDefinitionBackups, setNoDefinitionBackups] = useState(false)
  const [migrationNotice, setMigrationNotice] = useState<'destination_ready' | 'copy_complete'>()
  const [deviceRecovery, setDeviceRecovery] = useState<{ pending: boolean; error?: unknown }>()
  const clearMigrationNotice = useCallback(() => setMigrationNotice(undefined), [])
  const definitionBackupAction = account ? (
    <div className="flex flex-wrap items-center gap-2">
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="stand-in-download-definition-backups"
        className="min-h-11 px-2 text-sm underline md:min-h-8"
        onClick={() => {
          const backups = collectPersonalAssistantDefinitionBackups(backendUrl, userId)
          setNoDefinitionBackups(!backups.length)
          if (backups.length)
            void saveBlobToDownloads(
              new Blob([JSON.stringify(backups, null, 2)], { type: 'application/json' }),
              'assistant-definition-backups.json'
            )
        }}
      >
        {t('standIn.account.download_backups')}
      </ControlButton>
      {noDefinitionBackups && <span role="status">{t('standIn.account.no_backups')}</span>}
    </div>
  ) : undefined
  const [dismissedMigrationScope, setDismissedMigrationScope] = useState<string>()
  const ownsLegacyTarget = !!legacyTarget && isStandInBindingOwner(legacyTarget.userId, userId)
  const staleLegacyDevice =
    !!legacyTarget &&
    (legacyTarget.userId === LOCAL_USER.id
      ? legacyTarget.deviceId !== deviceId
      : legacyBinding?.status === 'stopping' ||
        (legacyTarget.deviceId === deviceId &&
          legacyInstance.stoppedProfile?.lifecycle?.status === 'stopped') ||
        (legacyTarget.deviceId === deviceId &&
          (configuredDeviceOffline || directory?.rootUnavailable)))
  const accountRecovery =
    !!target &&
    (binding?.status === 'stopped' ||
      binding?.status === 'stopping' ||
      binding?.status === 'unavailable' ||
      directory?.rootUnavailable)
  const migrationTarget = accountRecovery
    ? target
    : ownsLegacyTarget && staleLegacyDevice
      ? legacyTarget
      : undefined
  const migrationInstance = accountRecovery ? instance : legacyInstance
  const migrationScope = migrationTarget
    ? JSON.stringify([migrationTarget.userId, migrationTarget.deviceId])
    : undefined
  const showMigration =
    !embedded &&
    !!binding &&
    !!migrationTarget &&
    dismissedMigrationScope !== migrationScope &&
    availableDevices.some(device => device.device_id !== migrationTarget.deviceId)
  const configureCloudDestination = async (device: string) => {
    const configured = await initializePersonalAssistantOnDevice(
      services.personalAssistantAccountApi!,
      t('standIn.personal.default_role'),
      device
    )
    publishAccount?.(configured)
  }
  const recoverDevice = async (operation: () => Promise<unknown>) => {
    setDeviceRecovery({ pending: true })
    try {
      await operation()
      setDeviceRecovery(undefined)
      instance.reload()
      legacyInstance.reload()
      setReentry(current => current + 1)
    } catch (error) {
      setDeviceRecovery({ pending: false, error })
    }
  }
  const cause = instance.errorCause ?? deviceRecovery?.error ?? projectError?.cause
  const failure =
    instance.error ?? (cause ? getStandInErrorMessage(cause, 'load_projects_failed') : null)
  const upgradeRequired = requiresStandInUpgrade(cause)
  const returnToAssistant = () => navigateTo('/stand-in')
  const returnAfterStop = useStableEvent((route: string) => {
    if (active && contentRoute === route && entry.kind !== 'home') returnToAssistant()
  })
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="personal-stand-in-workspace">
      {failure && !entryError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm text-error"
        >
          <span>{failure}</span>
          {upgradeRequired && (
            <Button
              type="button"
              size="sm"
              className="min-h-11 md:min-h-8"
              data-testid="stand-in-view-devices"
              onClick={() => navigateTo('/cloud-work')}
            >
              {t('standIn.view_devices')}
            </Button>
          )}
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="stand-in-project-catalog-retry"
            aria-busy={
              instance.error ? busy : projectError ? view.loadingProjects : deviceRecovery?.pending
            }
            className="min-h-11 px-2 underline md:min-h-8"
            onClick={() => {
              if (instance.error) {
                instance.reload()
              } else if (deviceRecovery?.error) {
                setDeviceRecovery(undefined)
                instance.reload()
              } else if (projectError) workspaceSource.reloadProjects()
            }}
          >
            {t('standIn.reload')}
          </ControlButton>
        </div>
      )}
      <TransientNotice
        message={migrationNotice ? t(`standIn.migration.${migrationNotice}`) : null}
        onClear={clearMigrationNotice}
        tone="success"
        visible={active}
      />
      {showMigration && migrationTarget && migrationScope && (
        <StandInMigration
          key={migrationScope}
          devices={devices}
          sourceDevice={migrationTarget.deviceId}
          roles={
            migrationInstance.stoppedProfile?.roles ??
            directory?.roles
              .filter(role => role.deviceId === migrationTarget.deviceId)
              .map(role => role.role) ??
            []
          }
          busy={migrationInstance.busy}
          onDismiss={() => setDismissedMigrationScope(migrationScope)}
          requestLeave={action =>
            overview.current ? overview.current.requestLeave(action) : action()
          }
          onMigrate={async (deviceId, roleId) => {
            const role = await migrationInstance.migrate(
              { userId, backendUrl, deviceId },
              roleId,
              t('standIn.title'),
              cloudAssistantServices.standInApi,
              !roleId || roleId === '@primary'
                ? () => configureCloudDestination(deviceId)
                : undefined
            )
            if (role === 'initialized') {
              setDismissedMigrationScope(migrationScope)
              setMigrationNotice('destination_ready')
              navigateTo('/stand-in')
              return
            }
            if (!role) throw new StandInMigrationError('not_stopped')
            if (!accountRecovery && (!roleId || roleId === '@primary'))
              await configureCloudDestination(deviceId)
            setDismissedMigrationScope(migrationScope)
            if (roleId && roleId !== '@primary') {
              const destination = await services.standInApi
                ?.personalGet(userId, deviceId, { deviceSettingsOnly: true })
                .catch(() => undefined)
              if (
                !destination ||
                destination.userId !== userId ||
                destination.executionDeviceId !== deviceId ||
                destination.lifecycle?.status
              ) {
                setMigrationNotice('copy_complete')
                navigateTo('/stand-in')
                return
              }
            }
            navigateTo(
              `/stand-in?${new URLSearchParams({ deviceId, profileId: role.id, settingsRequest: crypto.randomUUID() })}`
            )
          }}
        />
      )}
      {!embedded && configuredDeviceOffline && (
        <div className="flex flex-wrap items-center gap-2 px-5 py-2">
          <p role="alert" className="text-sm text-error">
            {t('standIn.errors.device_offline')}
          </p>
          <Button
            size="sm"
            variant="outline"
            data-testid="stand-in-open-offline-device-status"
            onClick={() => navigateTo('/cloud-work')}
          >
            {t('standIn.view_devices')}
          </Button>
          {binding?.status === 'active' && actions}
        </div>
      )}
      {entryError ? (
        <StandInRouteFailure
          title={experienceT('assistant.entry.linkTitle')}
          description={experienceT(`assistant.entry.errors.${entryError}`)}
          onReturn={returnToAssistant}
          onRetry={
            entryError === 'lookup_failed'
              ? () => {
                  instance.reload()
                  void retryEntry?.()
                }
              : undefined
          }
        />
      ) : entryLoading ? (
        <StandInRouteLoading />
      ) : !binding ? (
        !failure && <StandInRouteLoading />
      ) : !target ? (
        <section className="space-y-3 p-5">
          <p>{t('standIn.account.choose_execution_device')}</p>
          {[...new Set([localDeviceId, ...availableDeviceIds].filter(Boolean))].map(device => (
            <Button
              key={device}
              variant="outline"
              disabled={deviceRecovery?.pending}
              data-testid={'stand-in-choose-device-' + device}
              onClick={() => void recoverDevice(() => bindDevice(device))}
            >
              {findWorkbenchDevice(devices, device)?.name ?? t('standIn.account_local_profile')}
            </Button>
          ))}
        </section>
      ) : binding.status === 'stopped' && !independentRole ? (
        <section className="space-y-4 p-5" data-testid="stand-in-instance-stopped">
          <h2 className="text-heading-sm font-medium">{t('standIn.instance.stopped')}</h2>
          <p className="text-sm text-text-secondary">{t('standIn.instance.bind_help')}</p>
          {renderBindChoices(deviceChoices)}
        </section>
      ) : binding.status === 'stopping' ? (
        <section className="space-y-4 p-5" data-testid="stand-in-instance-stopping">
          <div className="flex items-center gap-2">
            <p role="status" className="text-sm">
              {t(busy ? 'standIn.instance.stopping' : 'standIn.instance.stop_pending')}
            </p>
            {actions}
          </div>
          {alternateDevices.length > 0 && renderBindChoices(alternateDevices)}
        </section>
      ) : binding.status === 'unavailable' || binding.status === 'activating' ? (
        <section className="space-y-4 p-5" data-testid="stand-in-instance-recovery">
          {actions}
          {alternateDevices.length > 0 && (
            <>
              <p className="text-sm text-text-secondary">
                {t('standIn.workspace.execution_device_help')}
              </p>
              {renderBindChoices(alternateDevices)}
            </>
          )}
        </section>
      ) : embedded ? (
        <StandInHomeSetup
          api={assistantServices.standInApi}
          userId={ownerId}
          deviceId={target.deviceId}
          active={active}
        >
          {settings => (
            <StandInHomeWorkspace
              key={`${ownerId}:${target.deviceId}`}
              services={assistantServices}
              userId={ownerId}
              deviceId={target.deviceId}
              localDeviceId={localDeviceId}
              active={active}
              onOpenTask={onOpenTask}
              settings={settings}
              account={account}
              isKnownAssistantDevice={isKnownAssistantDevice}
              projects={homeProjects}
              collaborationWork={collaborationWork}
            />
          )}
        </StandInHomeSetup>
      ) : showAssistantExperience ? (
        <CollaborationExpErrorBoundary
          key={experience.revision}
          fallback={
            <StandInRouteFailure
              title={experienceT('assistant.entry.loadTitle')}
              description={experienceT('assistant.entry.loadFailed')}
              onRetry={() =>
                setExperience(current => ({
                  revision: current.revision + 1,
                  Workspace: lazy(loadAssistantWorkspace),
                }))
              }
            />
          }
        >
          <Suspense fallback={<StandInRouteLoading />}>
            <AssistantWorkspace
              active={active}
              binding={target}
              services={assistantServices}
              conversation={entry.kind === 'conversation' ? entry : undefined}
              projects={projects}
              localDeviceId={localDeviceId}
              devices={devices}
              onSelectDevice={bindDevice}
              headerActions={
                !configuredDeviceOffline && binding.status === 'active' ? (
                  <Tooltip label={t('standIn.instance.stop')}>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="experience-header-tool"
                      data-testid="stand-in-instance-stop"
                      aria-label={t('standIn.instance.stop')}
                      disabled={busy}
                      onClick={requestStop}
                    >
                      <CircleStop size={16} aria-hidden="true" />
                    </Button>
                  </Tooltip>
                ) : undefined
              }
              onClose={onClose}
            />
          </Suspense>
        </CollaborationExpErrorBoundary>
      ) : api ? (
        <>
          {experienceEnabled && (
            <Button
              type="button"
              variant="ghost"
              className="ml-5 mt-2 w-fit max-md:min-h-11"
              data-testid="stand-in-context-back"
              onClick={() =>
                overview.current
                  ? overview.current.requestLeave(returnToAssistant)
                  : returnToAssistant()
              }
            >
              {experienceT('assistant.entry.back')}
            </Button>
          )}
          <StandInOverviewPage
            key={JSON.stringify([ownerId, selectedDevice, contentRoute])}
            ref={overview}
            headerActions={configuredDeviceOffline || independentRole ? undefined : actions}
            linkedRole={independentRole?.profileId}
            directoryError={directory?.error === failure ? undefined : directory?.error}
            primarySettingsActions={definitionBackupAction}
            isKnownAssistantDevice={isKnownAssistantDevice}
            account={account}
            onBindDevice={
              account && publishAccount && services.personalAssistantAccountApi
                ? async (roleId, device) => {
                    if (roleId === '@primary') return bindDevice(device)
                    const currentAccount = readAccount?.() ?? account
                    const definitions = currentAccount.definitions.map(entry => ({
                      roleId: entry.roleId,
                      name: entry.team.metadata.displayName ?? '',
                      prompt: entry.ghost.spec.systemPrompt,
                      executionDeviceId:
                        entry.roleId === roleId
                          ? device
                          : entry.bot.spec?.execution_policy?.environment_id,
                    }))
                    const cloudApi = services.personalAssistantAccountApi!
                    try {
                      publishAccount(
                        await cloudApi.updateDefinitions(currentAccount.revision, definitions)
                      )
                    } catch (cause) {
                      const latest = await cloudApi.get().catch(() => null)
                      if (latest) {
                        publishAccount(latest)
                        if (
                          latest.definitions.find(entry => entry.roleId === roleId)?.bot.spec
                            ?.execution_policy?.environment_id === device
                        )
                          return
                      }
                      throw cause
                    }
                  }
                : undefined
            }
            onSelectAssistantDevice={independentRole ? undefined : bindDevice}
            initialProfileId={roleLocation?.settings ? roleLocation.roleId : undefined}
            initialSelectedRoleId={roleLocation?.roleId}
            initialDeviceId={selectedDevice}
            primaryDeviceId={deviceId}
            roleLocations={directory?.roles}
            localDeviceId={localDeviceId}
            entryRequestKey={entryRequestKey}
            entryRoute={contentRoute}
            settingsRequestKey={roleLocation?.settings ? settingsRequest : undefined}
            initialWorkView={scheduled ? 'scheduled' : 'work'}
            onSelectLocation={
              independentRole
                ? (device, role, openSettings) => {
                    if (!role || role === '@primary') returnToAssistant()
                    else {
                      const params = new URLSearchParams({ deviceId: device, profileId: role })
                      if (openSettings) params.set('settingsRequest', crypto.randomUUID())
                      navigateTo('/stand-in?' + params.toString())
                    }
                  }
                : workspaceSource.selectLocation
            }
            api={api}
            projects={projects}
            services={assistantServices}
            devices={devices}
            userId={ownerId}
            active={active}
            onCancel={onClose}
            onOpenTask={onOpenTask}
          />
        </>
      ) : (
        <p role="alert" className="p-5 text-sm">
          {t('standIn.errors.backend_connection_unavailable')}
        </p>
      )}
      <ConfirmDialog
        open={
          active &&
          confirmStop !== null &&
          target?.userId === confirmStop.target.userId &&
          target?.deviceId === confirmStop.target.deviceId
        }
        title={t('standIn.instance.stop')}
        description={t('standIn.instance.stop_description')}
        cancelLabel={t('standIn.cancel')}
        confirmLabel={t('standIn.instance.stop')}
        confirmTestId="stand-in-instance-stop-confirm"
        cancelTestId="stand-in-instance-stop-cancel"
        pending={busy}
        destructive
        onClose={() => setConfirmStop(null)}
        onConfirm={() => {
          const request = confirmStop
          setConfirmStop(null)
          if (!request) return
          void instance.stop(request.target, request.version).then(accepted => {
            if (accepted) returnAfterStop(contentRoute)
          })
        }}
      />
    </div>
  )
}
