import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress, User } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getStandInErrorMessage,
  reportStandInError,
  requiresStandInUpgrade,
} from '@/lib/stand-in-error-message'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { createWeworkPlatformApi } from './weworkPlatformApi'
import { StandInOverviewPage } from './StandInOverviewPage'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { LOCAL_USER } from '@/api/local/localSession'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { availableStandInDevices } from './standInDevices'
import { useStandInInstance } from './useStandInInstance'
import { StandInMigration } from './StandInMigration'
import {
  navigateTo,
  WORKSPACE_NAVIGATION_EVENT,
  type WorkspaceNavigationDetail,
} from '@/lib/navigation'
import { useStandInRoleDirectory } from './useStandInRoleDirectory'
import { StandInHomeWorkspace } from './StandInHomeWorkspace'
import { StandInHomeSetup, StandInHomeSetupPrompt } from './StandInHomeSetup'
import type { PersonalHomeCollaborationWork } from './WeworkPersonalHome'

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
  useEffect(() => {
    if (embedded || !active || contentRoute !== '/stand-in') return
    const onNavigate = (event: Event) => {
      if ((event as CustomEvent<WorkspaceNavigationDetail>).detail?.contentRoute === contentRoute)
        setReentry(current => current + 1)
    }
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
    return () => window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
  }, [active, contentRoute, embedded])
  const query = new URLSearchParams(contentRoute.split('?')[1] ?? '')
  const [initialBindingDevice] = useState(() => query.get('deviceId') ?? undefined)
  const instance = useStandInInstance(
    services,
    Number(user.id),
    devices,
    !!cloud?.isConnected,
    active,
    cloud?.apiBaseUrl ?? '',
    initialBindingDevice,
    refreshKey
  )
  const { binding, localDeviceId, busy } = instance
  const target = binding?.target
  const ownerId = target?.userId ?? Number(user.id)
  const notificationOwnerMatches = !query.get('userId') || query.get('userId') === String(ownerId)
  const deviceId = target?.deviceId
  const [roleLocation, setRoleLocation] = useState<
    { deviceId: string; roleId?: string; settings?: boolean } | undefined
  >(() =>
    query.get('profileId') && query.get('profileId') !== '@primary' && query.get('deviceId')
      ? {
          deviceId: query.get('deviceId')!,
          roleId: query.get('profileId')!,
          settings: true,
        }
      : undefined
  )
  const bindingScope = target
    ? JSON.stringify([target.userId, target.deviceId, target.backendUrl ?? ''])
    : undefined
  const [locationBinding, setLocationBinding] = useState(bindingScope)
  if (locationBinding !== bindingScope) {
    setLocationBinding(bindingScope)
    if (locationBinding && bindingScope) setRoleLocation(undefined)
  }
  const selectedDevice =
    roleLocation?.roleId && roleLocation.roleId !== '@primary' ? roleLocation.deviceId : deviceId
  const ownerAvailable =
    notificationOwnerMatches &&
    (binding?.status === 'stopped' ||
      ownerId === LOCAL_USER.id ||
      (ownerId === Number(user.id) && (target?.backendUrl ?? '') === (cloud?.apiBaseUrl ?? '')))
  const routeMatches = !query.get('deviceId') || query.get('deviceId') === deviceId
  const directory = useStandInRoleDirectory(
    services.standInApi,
    ownerId,
    deviceId,
    !embedded && active && ownerAvailable && binding?.status === 'active',
    localDeviceId,
    refreshKey,
    cloud?.isConnected ? availableStandInDevices(devices).map(device => device.device_id) : []
  )
  const [confirmStop, setConfirmStop] = useState<number | null>(null)
  const [error, setError] = useState<{ message: string; cause?: unknown } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  const overview = useRef<Pick<StandInSettingsHandle, 'requestLeave'>>(null)
  const previousEntry = useRef(JSON.stringify([contentRoute, entryRequestKey]))
  useEffect(() => {
    const entry = JSON.stringify([contentRoute, entryRequestKey])
    if (previousEntry.current === entry || !deviceId) return
    previousEntry.current = entry
    const params = new URLSearchParams(contentRoute.split('?')[1] ?? '')
    const roleId = params.get('profileId') ?? undefined
    const next = roleId && roleId !== '@primary' ? (params.get('deviceId') ?? deviceId) : deviceId
    const change = () =>
      setRoleLocation({ deviceId: next, roleId, settings: !!params.get('settingsRequest') })
    if (overview.current) overview.current.requestLeave(change)
    else change()
  }, [contentRoute, entryRequestKey, deviceId])
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
  useEffect(() => {
    if (embedded || !active || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    void invokeDesktopHost<void>('renderer.startupReady').catch(cause => {
      console.error('[Wework] Failed to reveal the personal stand-in workspace', cause)
    })
  }, [active, embedded])
  useEffect(() => {
    if (embedded || !api || !active || !target || !ownerAvailable || binding?.status !== 'active')
      return
    let current = true
    void api.projects.list().then(
      rows => {
        if (current) {
          setProjects(rows)
          setError(null)
        }
      },
      cause => {
        if (current) {
          reportStandInError('load_projects', cause)
          setError({ message: getStandInErrorMessage(cause, 'load_projects_failed'), cause })
        }
      }
    )
    return () => {
      current = false
    }
  }, [api, active, target, ownerAvailable, binding?.status, attempt, embedded])
  const actions = (
    <button
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
    </button>
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
          <button
            type="button"
            data-testid="stand-in-project-catalog-retry"
            className="min-h-11 px-2 underline md:min-h-8"
            onClick={() => {
              instance.reload()
              setAttempt(value => value + 1)
            }}
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      {!binding ? (
        !failure && (
          <p role="status" className="p-5 text-sm">
            {t('standIn.loading')}
          </p>
        )
      ) : !ownerAvailable ? (
        <p role="alert" className="p-5 text-sm">
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
              <button
                key={`${value.userId}:${value.deviceId}`}
                type="button"
                data-testid={`stand-in-instance-bind-${value.userId}-${value.deviceId}`}
                disabled={busy}
                className="min-h-11 rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
                onClick={() =>
                  void instance.bind({
                    userId: value.userId,
                    deviceId: value.deviceId,
                    backendUrl: value.userId === LOCAL_USER.id ? '' : (cloud?.apiBaseUrl ?? ''),
                  })
                }
              >
                {value.name}
              </button>
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
                  { userId: Number(user.id), deviceId, backendUrl: cloud.apiBaseUrl ?? '' },
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
            onSelectLocation={(next, roleId, settings) => {
              if ((!roleId || roleId === '@primary') && next !== deviceId) {
                setError({ message: t('standIn.instance.stop_before_rebind') })
                return
              }
              setRoleLocation({ deviceId: next, roleId, settings })
            }}
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
