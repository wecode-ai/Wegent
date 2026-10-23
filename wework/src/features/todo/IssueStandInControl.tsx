import { useEffect, useState } from 'react'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInIcon } from '@wegent/collaboration'
import { StandInPopover } from './StandInPopover'

export function IssueStandInControl({
  api,
  project,
  services,
  devices,
  deviceId,
  onSelect,
  disabled,
  userId,
  profileId = '',
  onSelectProfile,
}: {
  userId?: number
  profileId?: string
  onSelectProfile?(id: string): void
  api: SharedWorkspaceApi
  project: CollaborationProject
  services: WorkbenchServices
  devices: DeviceInfo[]
  deviceId: string | null
  onSelect(deviceId: string | null): void
  disabled: boolean
}) {
  const { t } = useTranslation('common')
  const [currentDeviceId, setCurrentDeviceId] = useState('')
  const settingsKey = JSON.stringify([project.id, deviceId, profileId])
  const profilesKey = JSON.stringify([project.id, deviceId, userId])
  const [settingsResult, setSettingsResult] = useState<{
    key: string
    value: WorkspaceStandInSettings | null
    error?: string
  } | null>(null)
  const [profilesResult, setProfilesResult] = useState<{
    key: string
    rows: WorkspaceStandInSettings[]
  } | null>(null)
  const settings = settingsResult?.key === settingsKey ? settingsResult.value : null
  const profiles = profilesResult?.key === profilesKey ? profilesResult.rows : []
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void services
      .getLocalRuntimeSidebarIdentity?.()
      .then(identity => {
        if (active) setCurrentDeviceId(identity?.deviceId ?? '')
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [services])
  useEffect(() => {
    if (!deviceId || !api.standIn || !profileId) return
    let active = true
    void api.standIn
      .get(project.id, deviceId, profileId)
      .then(value => {
        if (active) setSettingsResult({ key: settingsKey, value })
      })
      .catch(cause => {
        if (active)
          setSettingsResult({
            key: settingsKey,
            value: null,
            error: cause instanceof Error ? cause.message : String(cause),
          })
      })
    return () => {
      active = false
    }
  }, [api, project.id, deviceId, profileId, settingsKey])
  useEffect(() => {
    if (!deviceId || userId == null || !services.standInApi) return
    let active = true
    void services.standInApi
      .list(userId, deviceId, true)
      .then(rows => {
        if (active)
          setProfilesResult({
            key: profilesKey,
            rows: rows.filter(
              row =>
                row.projectId === project.id &&
                row.projectStore === (project.project_store === 'local' ? 'local' : 'cloud')
            ),
          })
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [services, deviceId, userId, project.id, project.project_store, profilesKey])
  const targets = devices.filter(
    device =>
      project.project_store !== 'local' ||
      [device.device_id, device.app_device_id].includes(currentDeviceId)
  )
  const summary = settings?.workspace
    ? `${settings.workspace.projectKey} · ${t(settings.workspace.executionMode === 'git_worktree' ? 'standIn.new_worktree' : 'standIn.current_workspace')}`
    : t('standIn.inherit_environment')
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="issue-stand-in-control">
      <button
        type="button"
        data-testid="issue-stand-in-select"
        aria-pressed={Boolean(deviceId)}
        disabled={disabled || (!deviceId && !currentDeviceId)}
        onClick={() => onSelect(deviceId ? null : currentDeviceId)}
        className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-muted md:min-h-7"
      >
        <StandInIcon enabled={Boolean(deviceId)} />
        {t('standIn.use_for_task')}
      </button>
      {deviceId && (
        <>
          <select
            data-testid="issue-stand-in-device"
            aria-label={t('standIn.device')}
            value={deviceId}
            disabled={disabled}
            onChange={event => onSelect(event.target.value)}
            className="min-h-11 max-w-40 rounded-md bg-transparent text-sm md:min-h-7"
          >
            {!targets.some(device =>
              [device.device_id, device.app_device_id].includes(deviceId)
            ) && (
              <option value={deviceId}>
                {deviceId === currentDeviceId
                  ? t('standIn.current_device')
                  : t('standIn.device_unavailable')}
              </option>
            )}
            {targets.map(device => (
              <option
                key={device.device_id}
                value={
                  [device.device_id, device.app_device_id].includes(deviceId)
                    ? deviceId
                    : device.device_id
                }
              >
                {device.name}
                {device.status === 'offline' ? ` · ${t('standIn.offline')}` : ''}
              </option>
            ))}
          </select>
          {profiles.some(profile => profile.id !== 'default') && (
            <select
              data-testid="issue-stand-in-profile"
              aria-label={t('standIn.existing_profile')}
              value={profileId}
              disabled={disabled}
              onChange={event => onSelectProfile?.(event.target.value)}
              className="min-h-11 max-w-40 rounded-md bg-transparent text-sm md:min-h-7"
            >
              <option value="">{t('standIn.personal.auto_role')}</option>
              <option value="default">{t('standIn.personal.default_role')}</option>
              {profiles
                .filter(profile => profile.id !== 'default')
                .map(profile => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name || profile.id}
                  </option>
                ))}
            </select>
          )}
          <StandInPopover
            key={`${project.id}:${deviceId}:${profileId}`}
            api={api}
            project={project}
            services={services}
            devices={devices}
            readLocalIdentity={services.getLocalRuntimeSidebarIdentity}
            initialDeviceId={deviceId}
            initialProfileId={profileId || undefined}
            userId={userId}
            onSaved={value => {
              setSettingsResult({
                key: JSON.stringify([project.id, value.executionDeviceId, value.id ?? 'default']),
                value,
              })
              onSelect(value.executionDeviceId)
              onSelectProfile?.(value.id ?? 'default')
            }}
          />
          <span
            data-testid="issue-stand-in-summary"
            className="max-w-64 truncate text-xs text-text-muted"
            title={summary}
          >
            {!profileId
              ? t('standIn.personal.auto_role')
              : settings
                ? summary
                : t('standIn.loading')}
          </span>
          {(error || (settingsResult?.key === settingsKey && settingsResult.error)) && (
            <span role="alert" className="text-xs text-error">
              {error || settingsResult?.error}
            </span>
          )}
        </>
      )}
    </div>
  )
}
