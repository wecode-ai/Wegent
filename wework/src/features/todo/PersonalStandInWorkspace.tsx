import { StandInCloudConnectionPrompt } from './StandInCloudConnectionPrompt'
import { LOCAL_USER } from '@/api/local/localSession'
import type { PersonalAssistantAccount } from '@/api/personalAssistantAccount'
import { isStandInBindingOwner } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
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
import { findWorkbenchDevice } from '@/lib/workbench-device'
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
import { PersonalAssistantAccountSetup } from './PersonalAssistantAccountSetup'
import { personalAssistantDeviceSettings } from './personalAssistantDeviceSettings'
import { createPersonalStandInWorkspaceSource } from './personalStandInWorkspaceSource'
import { availableStandInDevices } from './standInDevices'
import { StandInActivation } from './StandInActivation'
import { StandInHomeSetup, StandInHomeSetupPrompt } from './StandInHomeSetup'
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
            publishAccount={publishAccount}
            readAccount={readAccount}
          />
        )}
      </PersonalAssistantAccountSetup>
    )
  }
  return <StandInCloudConnectionPrompt />
}

/** Scope binding, project errors and recovery actions to the connected account. */
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
  account: connectedAccount,
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
  const instance = useStandInInstance(
    services,
    userId,
    devices,
    !!cloud?.isConnected,
    active,
    backendUrl,
    refreshKey,
    experienceEnabled
  )
  const { binding, setupTarget, localDeviceId, busy } = instance
  const target = binding?.target
  const visibleTarget = target ?? setupTarget
  const ownerId = visibleTarget?.userId ?? Number(user.id)
  const deviceId = target?.deviceId
  const account = ownerId === userId ? connectedAccount : undefined
  const boundDeviceOffline = findWorkbenchDevice(devices, deviceId)?.status === 'offline'
  const cloudAssistantServices = useMemo(
    () =>
      readAccount && publishAccount
        ? personalAssistantDeviceSettings(services, readAccount, publishAccount)
        : services,
    [services, readAccount, publishAccount]
  )
  const assistantServices = ownerId === userId ? cloudAssistantServices : services
  const bindingScope = visibleTarget
    ? JSON.stringify([visibleTarget.userId, visibleTarget.deviceId])
    : undefined
  const ownerAvailable =
    binding?.status === 'stopped' || !target || isStandInBindingOwner(target.userId, userId)
  const [confirmStop, setConfirmStop] = useState<number | null>(null)
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
    binding?.status === 'active' && ownerAvailable ? (target ?? undefined) : undefined,
    authorizedDeviceIds,
    active && !embedded,
    entryRequestKey
  )
  const entryError =
    entry.kind === 'error'
      ? entry.error
      : entry.kind === 'home'
        ? undefined
        : !ownerAvailable || (entry.userId && binding && entry.userId !== String(ownerId))
          ? 'forbidden'
          : !binding && instance.error
            ? 'lookup_failed'
            : binding && binding.status !== 'active'
              ? 'not_found'
              : entry.kind === 'conversation' && !experienceEnabled
                ? 'unsupported'
                : result?.kind === 'error'
                  ? result.error
                  : undefined
  const entryLoading =
    entry.kind !== 'home' && (!binding || (entry.kind === 'identity' && result?.kind !== 'ready'))
  const verifiedRole = result?.kind === 'ready' ? result : undefined
  const settingsRequest = entry.kind === 'identity' ? entry.settingsRequest : undefined
  const scheduled = 'scheduled' in entry && entry.scheduled
  const routeLocation = useMemo(
    () =>
      !entryError && !entryLoading
        ? {
            key: JSON.stringify([contentRoute, entryRequestKey, bindingScope]),
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
      bindingScope,
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
          bindingScope,
          target: visibleTarget,
          bindingStatus: binding?.status,
          ownerAvailable,
          active,
          embedded,
          entry: routeLocation,
          requestLeave: action =>
            overview.current ? overview.current.requestLeave(action) : action(),
        },
        listener
      ),
    [
      workspaceSource,
      api,
      bindingScope,
      visibleTarget,
      binding?.status,
      ownerAvailable,
      active,
      embedded,
      routeLocation,
    ]
  )
  const view = useSyncExternalStore(
    subscribe,
    workspaceSource.getSnapshot,
    workspaceSource.getSnapshot
  )
  const roleLocation =
    view.entryKey === routeLocation?.key && view.selectionScope === bindingScope
      ? view.roleLocation
      : routeLocation?.location
  const selectedDevice =
    roleLocation?.roleId && roleLocation.roleId !== '@primary' ? roleLocation.deviceId : deviceId
  const sameProjectOwner = view.projectsApi === api && view.projectsScope === bindingScope
  const projects = sameProjectOwner ? view.projects : []
  const error =
    sameProjectOwner && view.error
      ? view.error.kind === 'projects'
        ? {
            message: getStandInErrorMessage(view.error.cause, 'load_projects_failed'),
            cause: view.error.cause,
          }
        : { message: t('standIn.instance.stop_before_rebind'), cause: undefined }
      : null
  const directory = useStandInRoleDirectory(
    services.standInApi,
    ownerId,
    deviceId,
    !embedded &&
      active &&
      ownerAvailable &&
      !entryError &&
      !entryLoading &&
      !showAssistantExperience &&
      binding?.status === 'active',
    localDeviceId,
    refreshKey,
    availableDeviceIds
  )
  const actions = (
    <ControlButton
      variant="unstyled"
      type="button"
      data-testid="stand-in-instance-stop"
      disabled={busy || !ownerAvailable}
      className="ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-50 md:min-h-8"
      onClick={() => {
        const confirm = () => {
          if (binding) setConfirmStop(binding.version)
        }
        if (overview.current) overview.current.requestLeave(confirm)
        else confirm()
      }}
    >
      {t(binding?.status === 'stopping' ? 'standIn.instance.retry_stop' : 'standIn.instance.stop')}
    </ControlButton>
  )
  const failure = instance.error || error?.message
  const upgradeRequired = requiresStandInUpgrade(
    instance.error ? instance.errorCause : error?.cause
  )
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
              instance.reload()
              workspaceSource.reloadProjects()
            }}
          >
            {t('standIn.reload')}
          </ControlButton>
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
        !failure && (
          <p role="status" className="p-5 text-sm">
            {t('standIn.loading')}
          </p>
        )
      ) : !ownerAvailable ? (
        <p role="alert" className="p-5 text-sm" data-testid="stand-in-instance-owner-unavailable">
          {t('standIn.instance.owner_unavailable')}
        </p>
      ) : (binding.status === 'unbound' || binding.status === 'stopped') && embedded ? (
        <StandInHomeSetupPrompt />
      ) : binding.status === 'unbound' ? (
        setupTarget ? (
          <StandInActivation
            active={active}
            services={assistantServices}
            target={setupTarget}
            localDeviceId={localDeviceId}
            projects={projects}
            devices={devices}
            error={instance.error}
            busy={busy}
            onActivate={instance.setup}
            onClose={onClose}
          />
        ) : (
          !failure && <StandInRouteLoading />
        )
      ) : binding.status === 'stopped' ? (
        <section className="space-y-4 p-5" data-testid="stand-in-instance-stopped">
          <h2 className="text-heading-sm font-medium">{t('standIn.instance.stopped')}</h2>
          <p className="text-sm text-text-secondary">{t('standIn.instance.bind_help')}</p>
          <div className="flex flex-wrap gap-2">
            {[
              ...(Number(user.id) === LOCAL_USER.id
                ? []
                : [
                    {
                      userId: Number(user.id),
                      deviceId: localDeviceId,
                      name: t('standIn.account_local_profile'),
                    },
                  ]),
              ...(cloud?.isConnected
                ? availableDevices.map(device => ({
                    userId: Number(user.id),
                    deviceId: device.device_id,
                    name: device.name,
                  }))
                : []),
            ].map(value => (
              <ControlButton
                variant="outline"
                size="sm"
                key={`${value.userId}:${value.deviceId}`}
                type="button"
                data-testid={`stand-in-instance-bind-${value.userId}-${value.deviceId}`}
                disabled={busy}
                className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
                onClick={() =>
                  void instance.bind({
                    userId: value.userId,
                    backendUrl: value.userId === LOCAL_USER.id ? '' : backendUrl,
                    deviceId: value.deviceId,
                  })
                }
              >
                {value.name}
              </ControlButton>
            ))}
          </div>
          {cloud?.isConnected && target && instance.stoppedProfile && (
            <StandInMigration
              devices={devices}
              sourceDevice={target.deviceId}
              roles={instance.stoppedProfile.roles}
              busy={busy}
              onMigrate={async (deviceId, roleId) => {
                const role = await instance.migrate(
                  { userId, backendUrl, deviceId },
                  roleId,
                  t('standIn.title'),
                  cloudAssistantServices.standInApi
                )
                if (!role) throw new Error(t('standIn.migration.not_stopped'))
                navigateTo(
                  `/stand-in?${new URLSearchParams({ deviceId, profileId: role.id, settingsRequest: crypto.randomUUID() })}`
                )
              }}
            />
          )}
        </section>
      ) : binding.status === 'stopping' ? (
        <section className="flex items-center gap-2 p-5" data-testid="stand-in-instance-stopping">
          <p role="status" className="text-sm">
            {t('standIn.instance.stopping')}
          </p>
          {actions}
        </section>
      ) : target?.userId === LOCAL_USER.id ? (
        <section className="space-y-3 p-5" data-testid="stand-in-legacy-binding">
          <p>{t('standIn.account.legacy_binding')}</p>
          {actions}
        </section>
      ) : target && embedded ? (
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
              projects={homeProjects}
              collaborationWork={collaborationWork}
            />
          )}
        </StandInHomeSetup>
      ) : target && showAssistantExperience ? (
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
              conversation={entry.kind === 'conversation' ? entry : undefined}
              projects={projects}
              localDeviceId={localDeviceId}
              devices={devices}
              headerActions={actions}
              onClose={onClose}
            />
          </Suspense>
        </CollaborationExpErrorBoundary>
      ) : target && api ? (
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
          {(directory?.error || boundDeviceOffline) && (
            <div className="flex flex-wrap items-center gap-2 px-5 py-2">
              <p role="alert" className="text-sm text-error">
                {directory?.error || t('standIn.errors.device_offline')}
              </p>
              {boundDeviceOffline && actions}
            </div>
          )}
          <StandInOverviewPage
            key={JSON.stringify([ownerId, selectedDevice, contentRoute])}
            ref={overview}
            headerActions={boundDeviceOffline ? undefined : actions}
            account={account}
            onBindDevice={
              account && publishAccount && services.personalAssistantAccountApi
                ? async (roleId, device) => {
                    const definitions = account.definitions.map(entry => ({
                      roleId: entry.roleId,
                      name: entry.bot.metadata.displayName ?? '',
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
      <ConfirmDialog
        open={active && confirmStop !== null}
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
          const version = confirmStop
          setConfirmStop(null)
          if (version === null) return
          void instance.stop(version)
          if (entry.kind !== 'home') returnToAssistant()
        }}
      />
    </div>
  )
}
