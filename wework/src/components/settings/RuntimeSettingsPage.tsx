import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { CloudProject } from '@/api/deliveries'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import { MenuSelect } from '@/components/common/MenuSelect'
import { CloudTodoModal } from '@/features/todo/CloudTodoModal'
import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from '@/features/dsh-runtime/dshUiSlots'
import { useDshSlotEntries } from '@/features/dsh-runtime/useDshSlotEntries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'

import { SettingsGroup, SettingsPage, SettingsPageHeader, SettingsRow } from './settings-ui'

interface RuntimeSettingsPageProps {
  runtimeProfileApi?: WorkbenchServices['runtimeProfileApi']
  deliveryApi?: WorkbenchServices['deliveryApi']
  deviceApi?: WorkbenchServices['deviceApi']
  modelApi?: WorkbenchServices['modelApi']
}

export function RuntimeSettingsPage({
  runtimeProfileApi,
  deliveryApi,
  deviceApi,
  modelApi,
}: RuntimeSettingsPageProps) {
  const { t } = useTranslation('common')
  const workspacePolicies = useDshSlotEntries<WeworkDshSlotEntry>(
    WEWORK_DSH_SLOTS.runtimeProfileWorkspacePolicy
  )
  const [profiles, setProfiles] = useState<RuntimeProfile[]>([])
  const [projects, setProjects] = useState<CloudProject[]>([])
  const [projectDefaults, setProjectDefaults] = useState<Record<string, string>>({})
  const [devices, setDevices] = useState<
    Array<{ device_id: string; device_type?: string; status?: string; name?: string }>
  >([])
  const [models, setModels] = useState<Array<{ name: string; type?: string }>>([])
  const [creating, setCreating] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [model, setModel] = useState('')
  const [workspacePolicy, setWorkspacePolicy] = useState('project')
  const effectiveWorkspacePolicy =
    workspacePolicy === 'project' || workspacePolicies.some(option => option.id === workspacePolicy)
      ? workspacePolicy
      : 'project'

  const load = useCallback(async () => {
    if (!runtimeProfileApi) return
    const [nextProfiles, projectResponse, nextDevices, modelResponse] = await Promise.all([
      runtimeProfileApi.list(),
      deliveryApi?.listCloudProjects() ?? Promise.resolve({ items: [] }),
      deviceApi?.listDevices() ?? Promise.resolve([]),
      modelApi?.listModels() ?? Promise.resolve({ data: [] }),
    ])
    const nextProjects = projectResponse.items.filter(project => project.task_provider === 'local')
    const defaults = await Promise.all(
      nextProjects.map(project =>
        runtimeProfileApi
          .getProjectDefault(project.id)
          .then(value => [String(project.id), value.runtimeProfileId ?? ''] as const)
      )
    )
    setProfiles(nextProfiles)
    setProjects(nextProjects)
    setProjectDefaults(Object.fromEntries(defaults))
    setDevices(nextDevices)
    setModels(
      modelResponse.data.filter(isSupportedModelFamily).map(item => ({
        name: item.name,
        type: item.type,
      }))
    )
  }, [deliveryApi, deviceApi, modelApi, runtimeProfileApi])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const selectedDevice = devices.find(device => device.device_id === deviceId)
  const environment =
    selectedDevice?.device_type === 'cloud' || selectedDevice?.device_type === 'remote'
      ? 'cloud'
      : 'local'
  const modelOptions = useMemo(
    () =>
      models
        .filter(candidate => environment === 'local' || candidate.type !== 'runtime')
        .map(candidate => ({ value: candidate.name, label: candidate.name })),
    [environment, models]
  )
  const profileOptions = profiles.map(profile => ({ value: profile.id, label: profile.name }))

  const openCreate = () => {
    setError(null)
    setName('')
    setDeviceId(devices[0]?.device_id ?? '')
    setModel(models[0]?.name ?? '')
    setWorkspacePolicy('project')
    setCreating(true)
  }

  const create = async () => {
    if (!runtimeProfileApi || !name.trim() || !deviceId || busyKey) return
    setBusyKey('create')
    setError(null)
    try {
      await runtimeProfileApi.create({
        name: name.trim(),
        executionEnvironment: environment,
        executionDeviceId: deviceId,
        model,
        workspacePolicy: effectiveWorkspacePolicy,
      })
      await load()
      setCreating(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyKey(null)
    }
  }

  if (!runtimeProfileApi) {
    return (
      <SettingsPage data-testid="runtime-settings-page">
        <SettingsPageHeader
          title={t('workbench.runtime_profiles_title')}
          description={t('workbench.runtime_profiles_unavailable')}
        />
      </SettingsPage>
    )
  }

  return (
    <SettingsPage data-testid="runtime-settings-page">
      <SettingsPageHeader
        title={t('workbench.runtime_profiles_title')}
        description={t('workbench.runtime_profiles_description')}
        actions={
          <button
            type="button"
            data-testid="runtime-profile-create"
            onClick={openCreate}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-xs font-medium text-background"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('workbench.runtime_profile_create')}
          </button>
        }
      />

      {error && !creating ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
      <SettingsGroup>
        {profiles.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-text-muted">
            {t('workbench.runtime_profiles_empty')}
          </div>
        ) : (
          profiles.map(profile => (
            <SettingsRow
              key={profile.id}
              data-testid={`runtime-profile-${profile.id}`}
              label={profile.name}
              description={`${profile.model} · ${
                devices
                  .find(device => device.device_id === profile.executionDeviceId)
                  ?.name?.trim() || t('workbench.environment_device_unknown', '未知设备')
              }`}
              control={
                <button
                  type="button"
                  data-testid={`runtime-profile-delete-${profile.id}`}
                  disabled={busyKey !== null}
                  onClick={() => {
                    setBusyKey(`delete:${profile.id}`)
                    setError(null)
                    void runtimeProfileApi
                      .delete(profile.id)
                      .then(load)
                      .catch(cause =>
                        setError(cause instanceof Error ? cause.message : String(cause))
                      )
                      .finally(() => setBusyKey(null))
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-red-600 disabled:opacity-40"
                  aria-label={t('workbench.runtime_profile_delete')}
                >
                  {busyKey === `delete:${profile.id}` ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </button>
              }
            />
          ))
        )}
      </SettingsGroup>

      {projects.length > 0 && profiles.length > 0 ? (
        <section className="mt-8">
          <h2 className="heading-sm text-text-primary">
            {t('workbench.runtime_project_defaults_title')}
          </h2>
          <p className="mb-3 mt-1 text-sm text-text-secondary">
            {t('workbench.runtime_project_defaults_description')}
          </p>
          <SettingsGroup>
            {projects.map(project => (
              <SettingsRow
                key={project.id}
                label={project.name}
                control={
                  <MenuSelect
                    testId={`runtime-project-default-${project.id}`}
                    value={projectDefaults[String(project.id)] ?? ''}
                    onChange={profileId => {
                      setBusyKey(`default:${project.id}`)
                      setError(null)
                      void runtimeProfileApi
                        .setProjectDefault(project.id, profileId)
                        .then(() =>
                          setProjectDefaults(current => ({
                            ...current,
                            [String(project.id)]: profileId,
                          }))
                        )
                        .catch(cause =>
                          setError(cause instanceof Error ? cause.message : String(cause))
                        )
                        .finally(() => setBusyKey(null))
                    }}
                    options={profileOptions}
                    disabled={busyKey !== null}
                  />
                }
              />
            ))}
          </SettingsGroup>
        </section>
      ) : null}

      {creating ? (
        <CloudTodoModal
          title={t('workbench.runtime_profile_create')}
          onClose={() => {
            if (!busyKey) setCreating(false)
          }}
        >
          <div className="space-y-4" data-testid="runtime-profile-create-dialog">
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
              {t('workbench.runtime_profile_stay_on_page')}
            </p>
            <label className="block text-xs text-text-secondary">
              {t('workbench.runtime_profile_name')}
              <input
                data-testid="runtime-profile-name"
                value={name}
                onChange={event => setName(event.target.value)}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-focus"
              />
            </label>
            <MenuSelect
              testId="runtime-profile-device"
              value={deviceId}
              onChange={setDeviceId}
              options={devices.map(device => ({
                value: device.device_id,
                label: `${
                  device.name?.trim() || t('workbench.environment_device_unknown', '未知设备')
                } · ${device.status ?? 'unknown'}`,
              }))}
            />
            <MenuSelect
              testId="runtime-profile-model"
              value={model}
              onChange={setModel}
              options={modelOptions}
            />
            <MenuSelect
              testId="runtime-profile-workspace"
              value={effectiveWorkspacePolicy}
              onChange={setWorkspacePolicy}
              options={[
                {
                  value: 'project',
                  label: t('workbench.runtime_profile_workspace_project'),
                },
                ...workspacePolicies.map(option => ({
                  value: option.id,
                  label: option.labelKey
                    ? t(`workbench.${String(option.labelKey)}`, option.label ?? option.id)
                    : (option.label ?? option.id),
                })),
              ]}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busyKey !== null}
                onClick={() => setCreating(false)}
                className="h-8 rounded-lg px-3 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid="runtime-profile-save"
                disabled={busyKey !== null || !name.trim() || !deviceId || !model}
                onClick={() => void create()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-xs font-medium text-background disabled:opacity-40"
              >
                {busyKey === 'create' ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('common.save')}
              </button>
            </div>
          </div>
        </CloudTodoModal>
      ) : null}
    </SettingsPage>
  )
}
