import { LOCAL_USER } from '@/api/local/localSession'
import { isStandInBindingOwner } from '@/api/standIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  navigateTo,
  WORKSPACE_NAVIGATION_EVENT,
  type WorkspaceNavigationDetail,
} from '@/lib/navigation'
import { getStandInErrorMessage, requiresStandInUpgrade } from '@/lib/stand-in-error-message'
import type { DeviceInfo, RuntimeTaskAddress, User } from '@/types/api'
import type { CollaborationProject } from '@wegent/collaboration'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { createPersonalStandInWorkspaceSource } from './personalStandInWorkspaceSource'
import { availableStandInDevices } from './standInDevices'
import { StandInHomeSetup, StandInHomeSetupPrompt } from './StandInHomeSetup'
import { StandInHomeWorkspace } from './StandInHomeWorkspace'
import { StandInMigration } from './StandInMigration'
import { StandInOverviewPage } from './StandInOverviewPage'
import type { StandInSettingsHandle } from './StandInSettingsPage'
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
}

export function PersonalStandInWorkspace(props: PersonalStandInWorkspaceProps) {
  const cloud = useContext(CloudConnectionContext)
  return (
    <AccountStandInWorkspace
      key={JSON.stringify([cloud?.apiBaseUrl ?? '', props.user.id])}
      {...props}
    />
  )
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
}: PersonalStandInWorkspaceProps) {
  const { t, i18n } = useTranslation('common')
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
  const [workspaceSource] = useState(() =>
    createPersonalStandInWorkspaceSource(contentRoute, entryRequestKey)
  )
  const query = new URLSearchParams(contentRoute.split('?')[1] ?? '')
  const [initialBindingDevice] = useState(() => query.get('deviceId') ?? undefined)
  const [workspaceView, setWorkspaceView] = useState<'conversation' | 'messages'>(() =>
    services.standInApi && 'connectionReadiness' in services.standInApi && !query.get('profileId')
      ? 'messages'
      : 'conversation'
  )
  const userId = Number(user.id)
  const backendUrl = cloud?.apiBaseUrl ?? ''
  const instance = useStandInInstance(
    services,
    userId,
    devices,
    !!cloud?.isConnected,
    active,
    backendUrl,
    initialBindingDevice,
    refreshKey
  )
  const { binding, localDeviceId, busy } = instance
  const target = binding?.target
  const ownerId = target?.userId ?? Number(user.id)
  const notificationOwnerMatches = !query.get('userId') || query.get('userId') === String(ownerId)
  const deviceId = target?.deviceId
  const bindingScope = target ? JSON.stringify([target.userId, target.deviceId]) : undefined
  const ownerAvailable =
    notificationOwnerMatches &&
    (binding?.status === 'stopped' || !target || isStandInBindingOwner(target.userId, userId))
  const routeMatches = !query.get('deviceId') || query.get('deviceId') === deviceId
  const [confirmStop, setConfirmStop] = useState<number | null>(null)
  const overview = useRef<Pick<StandInSettingsHandle, 'requestLeave'>>(null)
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
          target,
          bindingStatus: binding?.status,
          ownerAvailable,
          active,
          embedded,
          contentRoute,
          entryRequestKey,
          requestLeave: action =>
            overview.current ? overview.current.requestLeave(action) : action(),
        },
        listener
      ),
    [
      workspaceSource,
      api,
      bindingScope,
      target,
      binding?.status,
      ownerAvailable,
      active,
      embedded,
      contentRoute,
      entryRequestKey,
    ]
  )
  const view = useSyncExternalStore(
    subscribe,
    workspaceSource.getSnapshot,
    workspaceSource.getSnapshot
  )
  const roleLocation =
    !view.selectionScope || !bindingScope || view.selectionScope === bindingScope
      ? view.roleLocation
      : undefined
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
    !embedded && active && ownerAvailable && binding?.status === 'active',
    localDeviceId,
    refreshKey,
    cloud?.isConnected ? availableStandInDevices(devices).map(device => device.device_id) : []
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
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="personal-stand-in-workspace">
      {failure && (
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
      {!binding ? (
        !failure && (
          <p role="status" className="p-5 text-sm">
            {t('standIn.loading')}
          </p>
        )
      ) : !ownerAvailable ? (
        <p role="alert" className="p-5 text-sm" data-testid="stand-in-instance-owner-unavailable">
          {t('standIn.instance.owner_unavailable')}
        </p>
      ) : binding.status === 'stopped' && embedded ? (
        <StandInHomeSetupPrompt />
      ) : binding.status === 'stopped' ? (
        <section className="space-y-4 p-5" data-testid="stand-in-instance-stopped">
          <h2 className="text-heading-sm font-medium">{t('standIn.instance.stopped')}</h2>
          <p className="text-sm text-text-secondary">{t('standIn.instance.bind_help')}</p>
          <div className="flex flex-wrap gap-2">
            {[
              { userId: LOCAL_USER.id, deviceId: localDeviceId, name: t('standIn.local_profile') },
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
                ? availableStandInDevices(devices).map(device => ({
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
                  t('standIn.title')
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
      ) : target && embedded ? (
        <StandInHomeSetup
          api={services.standInApi}
          userId={ownerId}
          deviceId={target.deviceId}
          active={active}
        >
          {settings => (
            <StandInHomeWorkspace
              key={`${ownerId}:${target.deviceId}`}
              services={services}
              userId={ownerId}
              deviceId={target.deviceId}
              localDeviceId={localDeviceId}
              active={active}
              onOpenTask={onOpenTask}
              settings={settings}
              projects={homeProjects}
              collaborationWork={collaborationWork}
            />
          )}
        </StandInHomeSetup>
      ) : target && api ? (
        <>
          {directory?.error && (
            <p role="alert" className="px-5 py-2 text-sm text-error">
              {directory.error}
            </p>
          )}
          <StandInOverviewPage
            key={`${ownerId}:${selectedDevice}`}
            ref={overview}
            workspaceView={workspaceView}
            onWorkspaceViewChange={setWorkspaceView}
            headerActions={actions}
            initialProfileId={
              roleLocation?.settings
                ? roleLocation.roleId
                : roleLocation
                  ? undefined
                  : (query.get('profileId') ?? undefined)
            }
            initialSelectedRoleId={roleLocation?.roleId}
            initialDeviceId={selectedDevice}
            primaryDeviceId={deviceId}
            roleLocations={directory?.roles}
            localDeviceId={localDeviceId}
            entryRequestKey={entryRequestKey}
            entryRoute={contentRoute}
            settingsRequestKey={
              roleLocation?.settings || routeMatches
                ? (query.get('settingsRequest') ?? undefined)
                : undefined
            }
            initialWorkView={query.get('view') === 'scheduled' ? 'scheduled' : 'work'}
            onSelectLocation={workspaceSource.selectLocation}
            api={api}
            projects={projects}
            services={services}
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
          if (version !== null) void instance.stop(version)
        }}
      />
    </div>
  )
}
