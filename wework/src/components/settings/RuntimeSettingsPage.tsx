import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'

import { MenuSelect } from '@/components/common/MenuSelect'
import { CloudTodoModal } from '@/features/todo/CloudTodoModal'
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

function createRuntimeSettingsResources({
  runtimeProfileApi,
  deliveryApi,
  deviceApi,
  modelApi,
}: RuntimeSettingsPageProps & {
  runtimeProfileApi: NonNullable<RuntimeSettingsPageProps['runtimeProfileApi']>
}) {
  return {
    profiles: createAsyncResource('settings/runtime-profiles', () => runtimeProfileApi.list()),
    projects: createAsyncResource('settings/runtime-project-defaults', async signal => {
      const response = await (deliveryApi?.listCloudProjects() ?? Promise.resolve({ items: [] }))
      signal.throwIfAborted()
      const projects = response.items.filter(project => project.task_provider === 'local')
      const defaults = await Promise.all(
        projects.map(project =>
          runtimeProfileApi
            .getProjectDefault(project.id)
            .then(value => [String(project.id), value.runtimeProfileId ?? ''] as const)
        )
      )
      return { projects, projectDefaults: Object.fromEntries(defaults) }
    }),
    devices: createAsyncResource(
      'settings/runtime-devices',
      () => deviceApi?.listDevices() ?? Promise.resolve([])
    ),
    models: createAsyncResource('settings/runtime-models', async () => {
      const response = await (modelApi?.listModels() ?? Promise.resolve({ data: [] }))
      return response.data
        .filter(isSupportedModelFamily)
        .map(item => ({ name: item.name, type: item.type }))
    }),
  }
}

export function RuntimeSettingsPage(props: RuntimeSettingsPageProps) {
  const { t } = useTranslation('common')
  const [source, setSource] = useState({ ...props, revision: 0 })
  if (
    source.runtimeProfileApi !== props.runtimeProfileApi ||
    source.deliveryApi !== props.deliveryApi ||
    source.deviceApi !== props.deviceApi ||
    source.modelApi !== props.modelApi
  ) {
    setSource({ ...props, revision: source.revision + 1 })
  }
  if (!props.runtimeProfileApi)
    return (
      <SettingsPage data-testid="runtime-settings-page">
        <SettingsPageHeader
          title={t('workbench.runtime_profiles_title')}
          description={t('workbench.runtime_profiles_unavailable')}
        />
      </SettingsPage>
    )
  return (
    <RuntimeSettingsContent
      key={source.revision}
      {...props}
      runtimeProfileApi={props.runtimeProfileApi}
    />
  )
}

function RuntimeSettingsContent(
  props: RuntimeSettingsPageProps & {
    runtimeProfileApi: NonNullable<RuntimeSettingsPageProps['runtimeProfileApi']>
  }
) {
  const { runtimeProfileApi } = props
  const { t } = useTranslation('common')
  const [resources] = useState(() => createRuntimeSettingsResources(props))
  const [creating, setCreating] = useState(false)
  const snapshot = useSyncExternalStore(
    resources.profiles.subscribe,
    resources.profiles.getSnapshot
  )
  const projectSnapshot = useSyncExternalStore(
    resources.projects.subscribe,
    resources.projects.getSnapshot
  )
  const deviceSnapshot = useSyncExternalStore(
    resources.devices.subscribe,
    resources.devices.getSnapshot
  )
  const modelSnapshot = useSyncExternalStore(
    creating ? resources.models.subscribe : subscribeIdleResource,
    creating ? resources.models.getSnapshot : getIdleResourceSnapshot
  )
  const profiles = snapshot.data ?? []
  const { projects = [], projectDefaults = {} } = projectSnapshot.data ?? {}
  const devices = deviceSnapshot.data ?? []
  const models = modelSnapshot.data ?? []
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const pending = useRef(false)
  const [actionError, setError] = useState<string | null>(null)
  const error = actionError
  const [name, setName] = useState('')
  const [deviceDraft, setDeviceId] = useState<string | null>(null)
  const deviceId = deviceDraft ?? devices[0]?.device_id ?? ''
  const [modelDraft, setModel] = useState<string | null>(null)

  const perform = async (key: string, action: () => Promise<unknown>) => {
    if (pending.current) return
    pending.current = true
    setBusyKey(key)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = false
      setBusyKey(null)
    }
  }

  const selectedDevice = devices.find(device => device.device_id === deviceId)
  const environment =
    selectedDevice?.device_type === 'cloud' || selectedDevice?.device_type === 'remote'
      ? 'cloud'
      : 'local'
  const modelOptions = models
    .filter(candidate => environment === 'local' || candidate.type !== 'runtime')
    .map(candidate => ({ value: candidate.name, label: candidate.name }))
  const model = modelDraft ?? modelOptions[0]?.value ?? ''
  const profileOptions = profiles.map(profile => ({ value: profile.id, label: profile.name }))

  const openCreate = () => {
    setError(null)
    setName('')
    setDeviceId(null)
    setModel(null)
    setCreating(true)
  }

  const create = async () => {
    if (!name.trim() || !deviceId) return
    await perform('create', async () => {
      await runtimeProfileApi.create({
        name: name.trim(),
        executionEnvironment: environment,
        executionDeviceId: deviceId,
        model,
      })
      if (!resources.profiles.hasSubscribers()) return
      setCreating(false)
      await Promise.all([resources.profiles.reload(), resources.projects.reload()])
    })
  }

  const failures = (
    [
      ['profiles', resources.profiles, snapshot],
      ['projects', resources.projects, projectSnapshot],
      ['devices', resources.devices, deviceSnapshot],
      ['models', resources.models, modelSnapshot],
    ] as const
  ).map(([name, resource, state]) =>
    state.status === 'error' ? (
      <div key={name} className="mb-3 text-xs text-destructive" role="alert">
        <p>{state.error instanceof Error ? state.error.message : String(state.error)}</p>
        <button
          type="button"
          data-testid={
            name === 'profiles' ? 'runtime-settings-retry' : `runtime-settings-${name}-retry`
          }
          onClick={() => void resource.reload()}
          className="mt-2 min-h-11 rounded-lg border border-border px-3 text-sm md:min-h-8"
        >
          {t('common.retry')}
        </button>
      </div>
    ) : null
  )

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
      {!creating && failures}
      <SettingsGroup>
        {!snapshot.settled ? (
          <p role="status" className="px-4 py-8 text-sm text-text-muted">
            {t('common.loading')}
          </p>
        ) : snapshot.data === undefined ? null : profiles.length === 0 ? (
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
                    void perform(`delete:${profile.id}`, async () => {
                      await runtimeProfileApi.delete(profile.id)
                      if (resources.profiles.hasSubscribers())
                        await Promise.all([
                          resources.profiles.reload(),
                          resources.projects.reload(),
                        ])
                    })
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-destructive disabled:opacity-40 wework:hover:text-red-600"
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
                      void perform(`default:${project.id}`, async () => {
                        const receipt = await runtimeProfileApi.setProjectDefault(
                          project.id,
                          profileId
                        )
                        resources.projects.update(
                          current =>
                            current && {
                              ...current,
                              projectDefaults: {
                                ...current.projectDefaults,
                                [String(project.id)]: receipt.runtimeProfileId ?? '',
                              },
                            }
                        )
                      })
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
            <label className="block text-xs text-text-secondary">
              {t('workbench.runtime_profile_name')}
              <input
                data-testid="runtime-profile-name"
                value={name}
                onChange={event => setName(event.target.value)}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none keyboard:focus:border-focus"
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
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {failures}
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
