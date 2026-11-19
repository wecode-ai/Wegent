import { Field, FieldLabel } from '@wegent/collaboration/controls/Field'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { LoaderCircle, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CloudProject } from '@/api/deliveries'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import { MenuSelect } from '@/components/common/MenuSelect'
import { CloudTodoModal } from '@/features/todo/CloudTodoModal'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { isSupportedModelFamily } from '@/lib/model-ui'

import { SettingsGroup, SettingsPage, SettingsPageHeader, SettingsRow } from './settings-ui'

interface RuntimeSettingsPageProps {
  runtimeProfileApi?: Pick<
    NonNullable<WorkbenchServices['runtimeProfileApi']>,
    'list' | 'create' | 'delete' | 'getProjectDefault' | 'setProjectDefault'
  >
  deliveryApi?: Pick<NonNullable<WorkbenchServices['deliveryApi']>, 'listCloudProjects'>
  deviceApi?: Pick<NonNullable<WorkbenchServices['deviceApi']>, 'listDevices'>
  modelApi?: Pick<NonNullable<WorkbenchServices['modelApi']>, 'listModels'>
}

export function RuntimeSettingsPage({
  runtimeProfileApi,
  deliveryApi,
  deviceApi,
  modelApi,
}: RuntimeSettingsPageProps) {
  const { t } = useTranslation('common')
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

  const [loading, setLoading] = useState(Boolean(runtimeProfileApi))
  const [hasLoadedProfiles, setHasLoadedProfiles] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [metadataErrors, setMetadataErrors] = useState<Record<string, string>>({})
  const [metadataPending, setMetadataPending] = useState<Record<string, boolean>>({})
  const requests = useRef({ profiles: 0, metadata: 0 })
  const load = useCallback(async () => {
    if (!runtimeProfileApi) return
    const request = ++requests.current.profiles
    setLoading(true)
    setLoadError(null)
    try {
      const next = await runtimeProfileApi.list()
      if (request === requests.current.profiles) {
        setProfiles(next)
        setHasLoadedProfiles(true)
      }
    } catch (cause) {
      if (request === requests.current.profiles)
        setLoadError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      if (request === requests.current.profiles) setLoading(false)
    }
  }, [runtimeProfileApi])
  const loadMetadata = useCallback(() => {
    if (!runtimeProfileApi) return
    const request = ++requests.current.metadata
    setMetadataErrors({})
    setMetadataPending({})
    const run = <T,>(key: string, operation: () => Promise<T>, accept: (value: T) => void) => {
      setMetadataPending(current => ({ ...current, [key]: true }))
      void Promise.resolve()
        .then(operation)
        .then(value => {
          if (request === requests.current.metadata) accept(value)
        })
        .catch(cause => {
          if (request === requests.current.metadata)
            setMetadataErrors(current => ({
              ...current,
              [key]: cause instanceof Error ? cause.message : String(cause),
            }))
        })
        .finally(() => {
          if (request === requests.current.metadata)
            setMetadataPending(current => ({ ...current, [key]: false }))
        })
    }
    if (deviceApi) run('device', () => deviceApi.listDevices(), setDevices)
    if (modelApi)
      run(
        'model',
        () => modelApi.listModels(),
        response =>
          setModels(
            response.data
              .filter(isSupportedModelFamily)
              .map(item => ({ name: item.name, type: item.type }))
          )
      )
    if (deliveryApi)
      run(
        'projects',
        () => deliveryApi.listCloudProjects(),
        response => {
          const available = response.items.filter(project => project.task_provider === 'local')
          setProjects(available)
          for (const project of available)
            if (runtimeProfileApi)
              run(
                'default:' + project.id,
                () => runtimeProfileApi.getProjectDefault(project.id),
                value => {
                  setProjectDefaults(current => ({
                    ...current,
                    [String(project.id)]: value.runtimeProfileId ?? '',
                  }))
                }
              )
        }
      )
  }, [deliveryApi, deviceApi, modelApi, runtimeProfileApi])
  useEffect(() => {
    const requestState = requests.current
    const timer = window.setTimeout(() => {
      void load().catch(() => undefined)
      loadMetadata()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      requestState.profiles++
      requestState.metadata++
    }
  }, [load, loadMetadata])

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
      })
      setCreating(false)
      void load().catch(() => undefined)
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
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            data-testid="runtime-profile-create"
            onClick={openCreate}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('workbench.runtime_profile_create')}
          </ControlButton>
        }
      />

      {error && !creating ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading || (!hasLoadedProfiles && !loadError) ? (
        <p
          role="status"
          data-testid="runtime-profiles-loading"
          className="mb-3 text-sm text-text-secondary"
        >
          {t('common.loading')}
        </p>
      ) : null}
      {loadError ? (
        <div
          role="alert"
          data-testid="runtime-profiles-load-error"
          className="mb-3 space-y-2 text-sm text-destructive"
        >
          <p>{loadError}</p>
          <ControlButton
            variant="outline"
            data-testid="runtime-profiles-retry"
            onClick={() => {
              void load().catch(() => undefined)
            }}
          >
            {t('common.retry', '重试')}
          </ControlButton>
        </div>
      ) : null}
      {Object.keys(metadataErrors).length > 0 ? (
        <div
          role="alert"
          data-testid="runtime-metadata-error"
          className="mb-3 space-y-2 text-sm text-destructive"
        >
          {[...new Set(Object.values(metadataErrors))].map(message => (
            <p key={message}>{message}</p>
          ))}
          <ControlButton
            variant="outline"
            data-testid="runtime-metadata-retry"
            onClick={loadMetadata}
          >
            {t('common.retry', '重试')}
          </ControlButton>
        </div>
      ) : null}
      <SettingsGroup>
        {profiles.length === 0 && hasLoadedProfiles && !loading && !loadError ? (
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
              children={
                <DeleteIconButton
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
                  aria-label={t('workbench.runtime_profile_delete')}
                  pending={busyKey === `delete:${profile.id}`}
                />
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
                children={
                  <MenuSelect
                    testId={`runtime-project-default-${project.id}`}
                    accessibleLabel={project.name}
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
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning wework:bg-amber-500/10 wework:text-amber-700">
              {t('workbench.runtime_profile_stay_on_page')}
            </p>
            <Field>
              <FieldLabel>{t('workbench.runtime_profile_name')}</FieldLabel>
              <ControlInput
                data-testid="runtime-profile-name"
                value={name}
                onChange={event => setName(event.target.value)}
                className="w-full"
              />
            </Field>
            <MenuSelect
              testId="runtime-profile-device"
              field
              label={t('workbench.task_activity_execution_device')}
              description={metadataPending.device ? t('common.loading') : undefined}
              error={metadataErrors.device}
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
              field
              label={t('workbench.task_activity_execution_model')}
              description={metadataPending.model ? t('common.loading') : undefined}
              error={metadataErrors.model}
              value={model}
              onChange={setModel}
              options={modelOptions}
            />
            {metadataErrors.device || metadataErrors.model ? (
              <ControlButton
                variant="outline"
                data-testid="runtime-profile-metadata-retry"
                onClick={loadMetadata}
              >
                {t('common.retry', '重试')}
              </ControlButton>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <ControlButton
                variant="unstyled"
                type="button"
                disabled={busyKey !== null}
                onClick={() => setCreating(false)}
                className="h-8 rounded-lg px-3 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel')}
              </ControlButton>
              <ControlButton
                variant="primary"
                size="sm"
                type="button"
                data-testid="runtime-profile-save"
                disabled={busyKey !== null || !name.trim() || !deviceId || !model}
                onClick={() => void create()}
              >
                {busyKey === 'create' ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('common.save')}
              </ControlButton>
            </div>
          </div>
        </CloudTodoModal>
      ) : null}
    </SettingsPage>
  )
}
