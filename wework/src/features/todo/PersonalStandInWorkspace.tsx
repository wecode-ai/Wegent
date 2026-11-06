import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress, User } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { createWeworkPlatformApi } from './weworkPlatformApi'
import { StandInOverviewPage } from './StandInOverviewPage'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { LOCAL_USER } from '@/api/local/localSession'
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import type { StandInSettingsHandle } from './StandInSettingsPage'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import type { PersonalStandInSettings } from '@/api/personalStandIn'
import { availableStandInDevices } from './standInDevices'

function configuredProfile(profile: PersonalStandInSettings | undefined) {
  return Boolean(
    profile &&
    (profile.version > 0 ||
      profile.roles.some(
        role =>
          role.version > 0 || role.enabled || role.name || role.prompt || role.connections?.length
      ) ||
      profile.primary?.prompt ||
      profile.primary?.preferences)
  )
}

type PersonalStandInWorkspaceProps = {
  services: WorkbenchServices
  user: User
  devices: DeviceInfo[]
  active: boolean
  contentRoute: string
  onClose(): void
  onOpenTask(address: RuntimeTaskAddress): Promise<void> | void
}

export function PersonalStandInWorkspace(props: PersonalStandInWorkspaceProps) {
  const cloud = useContext(CloudConnectionContext)
  const accountKey = JSON.stringify([cloud?.apiBaseUrl ?? '', props.user.id])
  return <AccountStandInWorkspace key={accountKey} {...props} />
}

function AccountStandInWorkspace({
  services,
  user,
  devices,
  active,
  contentRoute,
  onClose,
  onOpenTask,
}: PersonalStandInWorkspaceProps) {
  const { t, i18n } = useTranslation('common')
  const cloud = useContext(CloudConnectionContext)
  const query = new URLSearchParams(contentRoute.split('?')[1] ?? '')
  const profileId = query.get('profileId') ?? undefined
  const routeDeviceId = query.get('deviceId') ?? undefined
  const preferenceKey = `wework.stand-in.cloud-device:${JSON.stringify([cloud?.apiBaseUrl ?? '', user.id])}`
  const [localDeviceId, setLocalDeviceId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [hasLocalProfile, setHasLocalProfile] = useState(false)
  const [initialLocation, setInitialLocation] = useState<{ deviceId: string; local: boolean }>()
  const [location, setLocation] = useState<
    | {
        route: string
        deviceId: string
        local: boolean
        profileId?: string
        roleId?: string
      }
    | undefined
  >(() => {
    if (routeDeviceId || profileId) return undefined
    try {
      const deviceId = localStorage.getItem(preferenceKey)
      return deviceId ? { route: contentRoute, deviceId, local: false } : undefined
    } catch {
      return undefined
    }
  })
  const selected = location?.route === contentRoute ? location : undefined
  const resolved = selected ?? (routeDeviceId ? undefined : initialLocation)
  const deviceId = resolved?.deviceId || routeDeviceId
  const ownerId = resolved?.local ? LOCAL_USER.id : Number(user.id)
  const overview = useRef<Pick<StandInSettingsHandle, 'requestLeave'>>(null)
  useEffect(() => {
    if (!active) return
    let current = true
    void (async () => {
      const identity = await services.getLocalRuntimeSidebarIdentity?.()
      if (!identity) throw new Error('Executor identity is unavailable')
      const account = Number(user.id)
      const [owned, local] = await Promise.all([
        services.standInApi?.personalGet(account, identity.deviceId),
        account === LOCAL_USER.id
          ? undefined
          : services.standInApi?.personalGet(LOCAL_USER.id, identity.deviceId),
      ])
      if (!current) return
      const localExists = configuredProfile(local)
      const available = cloud?.isConnected ? availableStandInDevices(devices) : []
      const preferred = available.find(device => device.is_default) ?? available[0]
      setLocalDeviceId(identity.deviceId)
      setLocationError(null)
      setHasLocalProfile(localExists)
      setInitialLocation(
        previous =>
          previous ?? {
            deviceId:
              profileId || configuredProfile(owned) || localExists
                ? identity.deviceId
                : (preferred?.device_id ?? identity.deviceId),
            local: !profileId && !configuredProfile(owned) && localExists,
          }
      )
    })().catch(cause => {
      if (current) setLocationError(getStandInErrorMessage(cause, 'load_settings_failed'))
    })
    return () => {
      current = false
    }
  }, [services, user.id, active, devices, cloud?.isConnected, profileId, attempt])
  const rememberLocation = (
    target: string,
    local = false,
    roleId?: string,
    openSettings = false
  ) => {
    try {
      if (local || target === localDeviceId) localStorage.removeItem(preferenceKey)
      else localStorage.setItem(preferenceKey, target)
    } catch {
      console.warn('[Wework] Could not remember the stand-in device')
    }
    setLocation({
      route: contentRoute,
      deviceId: target,
      local,
      roleId,
      profileId: openSettings ? roleId : undefined,
    })
  }
  const selectLocation = (target: string, local = false) => {
    const change = () => rememberLocation(target, local)
    if (overview.current) overview.current.requestLeave(change)
    else change()
  }
  const workView = query.get('view') === 'scheduled' ? 'scheduled' : 'work'
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  useEffect(() => {
    if (!active || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    void invokeDesktopHost<void>('renderer.startupReady').catch(cause => {
      console.error('[Wework] Failed to reveal the personal stand-in workspace', cause)
    })
  }, [active])
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
    if (!api || !active) return
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
          setError(getStandInErrorMessage(cause, 'load_projects_failed'))
        }
      }
    )
    return () => {
      current = false
    }
  }, [api, active, attempt])
  if (!api)
    return (
      <p role="alert" className="p-5 text-sm">
        {t('standIn.errors.backend_connection_unavailable')}
      </p>
    )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="personal-stand-in-workspace">
      {localDeviceId && (
        <label className="flex items-center gap-2 border-b border-border px-5 py-2 text-sm">
          <span>{t('standIn.device')}</span>
          <select
            data-testid="stand-in-workspace-location"
            className="min-h-11 min-w-0 rounded-md border border-border bg-background px-2 md:min-h-8"
            value={
              resolved?.local || ownerId === LOCAL_USER.id ? '@local' : (deviceId ?? localDeviceId)
            }
            onChange={event =>
              selectLocation(
                event.target.value === '@local' ? localDeviceId : event.target.value,
                event.target.value === '@local'
              )
            }
          >
            <option value="@local">{t('standIn.local_profile')}</option>
            {Number(user.id) !== LOCAL_USER.id && (
              <option value={localDeviceId}>{t('standIn.account_local_profile')}</option>
            )}
            {devices
              .filter(device => isCloudDevice(device) || isRemoteDevice(device))
              .map(device => (
                <option key={device.device_id} value={device.device_id}>
                  {device.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {(error || locationError) && (
        <div role="alert" className="flex items-center gap-2 px-5 py-2 text-sm text-error">
          <span>{locationError || error}</span>
          <button
            type="button"
            data-testid="stand-in-project-catalog-retry"
            onClick={() => setAttempt(value => value + 1)}
            className="min-h-11 px-2 underline md:min-h-8"
          >
            {t('standIn.reload')}
          </button>
        </div>
      )}
      {hasLocalProfile && !selected && (!deviceId || deviceId === localDeviceId) && (
        <div
          data-testid="stand-in-local-profile-offer"
          className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-sm"
        >
          <p className="flex-1">{t('standIn.migration.local_available')}</p>
          <button
            type="button"
            data-testid="stand-in-local-profile-open"
            onClick={() => selectLocation(localDeviceId, true)}
            className="min-h-11 rounded-md border border-border px-3 md:min-h-8"
          >
            {t('standIn.migration.view_local')}
          </button>
        </div>
      )}
      {services.getLocalRuntimeSidebarIdentity && !initialLocation && !routeDeviceId ? (
        locationError ? null : (
          <p role="status" className="p-5 text-sm">
            {t('standIn.loading')}
          </p>
        )
      ) : (
        <StandInOverviewPage
          key={`${ownerId}:${deviceId ?? 'default'}`}
          ref={overview}
          onSelectLocation={(target, roleId, openSettings) =>
            rememberLocation(target, false, roleId, openSettings)
          }
          initialSelectedRoleId={selected?.roleId}
          initialProfileId={selected ? selected.profileId : profileId}
          initialDeviceId={deviceId}
          settingsRequestKey={selected ? undefined : (query.get('settingsRequest') ?? undefined)}
          initialWorkView={workView}
          api={api}
          projects={projects}
          services={services}
          devices={devices}
          userId={ownerId}
          active={active}
          onCancel={onClose}
          onOpenTask={onOpenTask}
        />
      )}
    </div>
  )
}
