import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { CollaborationProject } from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress, User } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage, reportStandInError } from '@/lib/stand-in-error-message'
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
import { StandInBindingContext } from './StandInBindingContext'
import { useStandInInstance } from './useStandInInstance'
import { StandInMigration } from './StandInMigration'
import { navigateTo } from '@/lib/navigation'

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
  return (
    <AccountStandInWorkspace
      key={JSON.stringify([cloud?.apiBaseUrl ?? '', props.user.id])}
      {...props}
    />
  )
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
  const instance = useStandInInstance(
    services,
    Number(user.id),
    devices,
    !!cloud?.isConnected,
    active,
    cloud?.apiBaseUrl ?? '',
    query.get('deviceId') ?? undefined
  )
  const { binding, localDeviceId, busy } = instance
  const target = binding?.target
  const ownerId = target?.userId ?? Number(user.id)
  const deviceId = target?.deviceId
  const ownerAvailable =
    binding?.status === 'stopped' ||
    ownerId === LOCAL_USER.id ||
    (ownerId === Number(user.id) && (target?.backendUrl ?? '') === (cloud?.apiBaseUrl ?? ''))
  const routeMatches = !query.get('deviceId') || query.get('deviceId') === deviceId
  const [confirmStop, setConfirmStop] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [projects, setProjects] = useState<CollaborationProject[]>([])
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
  useEffect(() => {
    if (!active || !isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    void invokeDesktopHost<void>('renderer.startupReady').catch(cause => {
      console.error('[Wework] Failed to reveal the personal stand-in workspace', cause)
    })
  }, [active])
  useEffect(() => {
    if (!api || !active || !target || !ownerAvailable || binding?.status !== 'active') return
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
  }, [api, active, target, ownerAvailable, binding?.status, attempt])
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
  const failure = instance.error || error
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="personal-stand-in-workspace">
      {failure && (
        <div role="alert" className="flex items-center gap-2 px-5 py-2 text-sm text-error">
          <span>{failure}</span>
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
      ) : target && api ? (
        <StandInBindingContext.Provider value={target}>
          {!routeMatches && (
            <p role="alert" className="px-5 py-2 text-sm">
              {t('standIn.instance.stop_before_rebind')}
            </p>
          )}
          <StandInOverviewPage
            key={`${ownerId}:${deviceId}`}
            ref={overview}
            headerActions={actions}
            initialProfileId={routeMatches ? (query.get('profileId') ?? undefined) : undefined}
            initialDeviceId={deviceId}
            settingsRequestKey={
              routeMatches ? (query.get('settingsRequest') ?? undefined) : undefined
            }
            initialWorkView={query.get('view') === 'scheduled' ? 'scheduled' : 'work'}
            onSelectLocation={next => {
              if (next !== deviceId) setError(t('standIn.instance.stop_before_rebind'))
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
        </StandInBindingContext.Provider>
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
