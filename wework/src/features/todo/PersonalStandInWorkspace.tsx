import { useEffect, useMemo, useRef, useState } from 'react'
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

export function PersonalStandInWorkspace({
  services,
  user,
  devices,
  active,
  contentRoute,
  onClose,
  onOpenTask,
}: {
  services: WorkbenchServices
  user: User
  devices: DeviceInfo[]
  active: boolean
  contentRoute: string
  onClose(): void
  onOpenTask(address: RuntimeTaskAddress): Promise<void> | void
}) {
  const { t, i18n } = useTranslation('common')
  const query = new URLSearchParams(contentRoute.split('?')[1] ?? '')
  const profileId = query.get('profileId') ?? undefined
  const routeDeviceId = query.get('deviceId') ?? undefined
  const [localDeviceId, setLocalDeviceId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [hasLocalProfile, setHasLocalProfile] = useState(false)
  const [location, setLocation] = useState<{
    route: string
    deviceId: string
    local: boolean
    profileId?: string
  }>()
  const selected = location?.route === contentRoute ? location : undefined
  const deviceId = selected?.deviceId || routeDeviceId
  const ownerId = selected?.local ? LOCAL_USER.id : Number(user.id)
  const overview = useRef<Pick<StandInSettingsHandle, 'requestLeave'>>(null)
  useEffect(() => {
    let active = true
    void services
      .getLocalRuntimeSidebarIdentity?.()
      .then(identity => {
        if (active && identity) {
          setLocalDeviceId(identity.deviceId)
          if (Number(user.id) !== LOCAL_USER.id)
            void services.standInApi
              ?.personalGet(LOCAL_USER.id, identity.deviceId)
              .then(profile => {
                if (active)
                  setHasLocalProfile(
                    Boolean(
                      profile.roles.length ||
                      profile.primary?.enabled ||
                      profile.primary?.prompt ||
                      profile.primary?.preferences
                    )
                  )
              })
              .catch(cause => {
                if (active) setError(getStandInErrorMessage(cause, 'load_settings_failed'))
              })
        }
      })
      .catch(cause => {
        if (active) setError(getStandInErrorMessage(cause, 'load_settings_failed'))
      })
    return () => {
      active = false
    }
  }, [services, user.id])
  const selectLocation = (target: string, local = false) => {
    const change = () => setLocation({ route: contentRoute, deviceId: target, local })
    if (overview.current) overview.current.requestLeave(change)
    else change()
  }
  const workView = query.get('view') === 'scheduled' ? 'scheduled' : 'work'
  const [projects, setProjects] = useState<CollaborationProject[]>([])
  const [attempt, setAttempt] = useState(0)
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
              selected?.local || ownerId === LOCAL_USER.id ? '@local' : (deviceId ?? localDeviceId)
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
      {error && (
        <div role="alert" className="flex items-center gap-2 px-5 py-2 text-sm text-error">
          <span>{error}</span>
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
      {hasLocalProfile && ownerId !== LOCAL_USER.id && !deviceId && (
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
      <StandInOverviewPage
        key={`${ownerId}:${deviceId ?? 'default'}`}
        ref={overview}
        onSelectLocation={(target, profileId) =>
          setLocation({ route: contentRoute, deviceId: target, local: false, profileId })
        }
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
    </div>
  )
}
