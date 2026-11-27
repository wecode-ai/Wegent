import { StandInCloudConnectionPrompt } from './StandInCloudConnectionPrompt'
import { LOCAL_USER } from '@/api/local/localSession'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { isStandInBindingOwner } from '@/api/standIn'
import { TransientNotice } from '@/components/common/TransientNotice'
import { Button } from '@/components/ui/button'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { CollaborationExpErrorBoundary } from '@/features/collaboration-exp/CollaborationExpRoute'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
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
import { type StandInEntryError } from './standInEntry'
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
        key={key}
        services={props.services}
        userId={Number(props.user.id)}
        active={props.active}
      >
        {(account, publishAccount, readAccount) => (
          <AccountStandInWorkspace
            {...props}
            account={account}
            deviceId={
              account?.definitions.find(entry => entry.roleId === '@primary')?.bot.spec
                ?.execution_policy?.environment_id
            }
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
  deviceId,
  publishAccount,
  readAccount,
}: PersonalStandInWorkspaceProps & {
  account?: PersonalAssistantAccount
  deviceId?: string
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
  const instance = useStandInInstance(services, userId, devices, true, active, backendUrl, {
    entryRequestKey: refreshKey,
    legacyOnly: true,
  })
  const { localDeviceId, busy } = instance
  const legacyBinding = instance.binding
  const legacyTarget = legacyBinding?.target
  const ownerId = userId
  const target = useMemo(
    () => (deviceId ? { userId, backendUrl, deviceId } : undefined),
    [userId, backendUrl, deviceId]
  )
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
  const {
    entry,
    result,
    retry: retryEntry,
  } = useStandInEntry(
    contentRoute,
    assistantServices.standInApi,
    target,
    authorizedDeviceIds,
    active && !embedded,
    entryRequestKey
  )
  let entryError: StandInEntryError | undefined
  if (entry.kind === 'error') entryError = entry.error
  else if (entry.kind !== 'home') {
    if (entry.userId && entry.userId !== String(ownerId)) entryError = 'forbidden'
    else if (!target) entryError = 'not_found'
    else if (entry.kind === 'conversation' && !experienceEnabled) entryError = 'unsupported'
    else if (result?.kind === 'error') entryError = result.error
  }
  const entryLoading = entry.kind === 'identity' && result?.kind !== 'ready'
  const verifiedRole = result?.kind === 'ready' ? result : undefined
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
    view.entryKey === routeLocation?.key && view.selectionScope === accountScope
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
  const selectedDevice =
    roleLocation?.roleId && roleLocation.roleId !== '@primary'
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
      (!showAssistantExperience || Boolean(readLegacyRoles)),
    localDeviceId,
    refreshKey,
    availableDeviceIds
  )
  const [noDefinitionBackups, setNoDefinitionBackups] = useState(false)
  const [destinationReady, setDestinationReady] = useState(false)
  const [deviceRecovery, setDeviceRecovery] = useState<{ pending: boolean; error?: unknown }>()
  const clearDestinationNotice = useCallback(() => setDestinationReady(false), [])
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
  const legacyScope = legacyTarget
    ? JSON.stringify([legacyTarget.userId, legacyTarget.deviceId])
    : undefined
  const ownsLegacyTarget = !!legacyTarget && isStandInBindingOwner(legacyTarget.userId, userId)
  const staleLegacyDevice =
    !!legacyTarget &&
    (legacyTarget.userId === LOCAL_USER.id
      ? legacyTarget.deviceId !== deviceId
      : legacyBinding?.status === 'stopping' ||
        (legacyTarget.deviceId === deviceId &&
          instance.stoppedProfile?.lifecycle?.status === 'stopped') ||
        (legacyTarget.deviceId === deviceId &&
          (configuredDeviceOffline || directory?.rootUnavailable)))
  const showMigration =
    !embedded &&
    ownsLegacyTarget &&
    staleLegacyDevice &&
    dismissedMigrationScope !== legacyScope &&
    availableDevices.some(device => device.device_id !== legacyTarget?.deviceId)
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
      setReentry(current => current + 1)
    } catch (error) {
      setDeviceRecovery({ pending: false, error })
    }
  }
  const cause = deviceRecovery?.error ?? projectError?.cause
  const failure = cause ? getStandInErrorMessage(cause, 'load_projects_failed') : null
  const upgradeRequired = requiresStandInUpgrade(cause)
  const returnToAssistant = () => navigateTo('/stand-in')
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
            aria-busy={view.loadingProjects}
            className="min-h-11 px-2 underline md:min-h-8"
            onClick={() => {
              setDeviceRecovery(undefined)
              instance.reload()
              workspaceSource.reloadProjects()
            }}
          >
            {t('standIn.reload')}
          </ControlButton>
        </div>
      )}
      <TransientNotice
        message={destinationReady ? t('standIn.migration.destination_ready') : null}
        onClear={clearDestinationNotice}
        tone="success"
        visible={active}
      />
      {showMigration && legacyTarget && legacyScope && (
        <StandInMigration
          key={legacyScope}
          devices={devices}
          sourceDevice={legacyTarget.deviceId}
          roles={
            instance.stoppedProfile?.roles ??
            directory?.roles
              .filter(role => role.deviceId === legacyTarget.deviceId)
              .map(role => role.role) ??
            []
          }
          busy={busy}
          onDismiss={() => setDismissedMigrationScope(legacyScope)}
          requestLeave={action =>
            overview.current ? overview.current.requestLeave(action) : action()
          }
          onMigrate={async (deviceId, roleId) => {
            const role = await instance.migrate(
              { userId, backendUrl, deviceId },
              roleId,
              t('standIn.title'),
              cloudAssistantServices.standInApi,
              () => configureCloudDestination(deviceId)
            )
            if (role === 'initialized') {
              setDismissedMigrationScope(legacyScope)
              setDestinationReady(true)
              navigateTo('/stand-in')
              return
            }
            if (!role) throw new StandInMigrationError('not_stopped')
            if (!roleId || roleId === '@primary') await configureCloudDestination(deviceId)
            setDismissedMigrationScope(legacyScope)
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
      ) : !target ? (
        <section className="space-y-3 p-5">
          <p>{t('standIn.account.choose_execution_device')}</p>
          {[...new Set([localDeviceId, ...availableDeviceIds].filter(Boolean))].map(device => (
            <Button
              key={device}
              variant="outline"
              disabled={deviceRecovery?.pending}
              data-testid={'stand-in-choose-device-' + device}
              onClick={() => void recoverDevice(() => configureCloudDestination(device))}
            >
              {findWorkbenchDevice(devices, device)?.name ?? t('standIn.account_local_profile')}
            </Button>
          ))}
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
              onSelectDevice={configureCloudDestination}
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
            directoryError={directory?.error === failure ? undefined : directory?.error}
            primarySettingsActions={definitionBackupAction}
            isKnownAssistantDevice={isKnownAssistantDevice}
            account={account}
            onBindDevice={
              account && publishAccount && services.personalAssistantAccountApi
                ? async (roleId, device) => {
                    const definitions = account.definitions.map(entry => ({
                      roleId: entry.roleId,
                      name: entry.team.metadata.displayName ?? '',
                      prompt: entry.ghost.spec.systemPrompt,
                      executionDeviceId: entry.roleId === roleId ? device : undefined,
                    }))
                    publishAccount(
                      await services.personalAssistantAccountApi!.updateDefinitions(
                        account.revision,
                        definitions
                      )
                    )
                  }
                : undefined
            }
            onSelectAssistantDevice={configureCloudDestination}
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
            onSelectLocation={workspaceSource.selectLocation}
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
    </div>
  )
}
