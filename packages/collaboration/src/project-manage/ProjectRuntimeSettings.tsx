import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

import type { CollaborationTranslate } from '../i18n'
import {
  useRuntimeConfiguration,
  useRuntimeConfigurationRevision,
  type ProfileConfigurationTarget,
} from '../runtime-profile/context'
import type { SharedWorkspaceApi, WorkspaceRuntimeProfile } from '../ports/SharedWorkspaceApi'

import {
  createProjectRuntimeSettingsResource,
  RuntimeCatalogUnavailableError,
} from './projectRuntimeSettingsResource'

function complete(profile: WorkspaceRuntimeProfile | undefined): boolean {
  return Boolean(profile?.status === 'active' && profile.executionDeviceId && profile.model)
}

export function ProjectRuntimeSettings({
  api,
  projectId,
  translate: t,
  onConfigureEnvironments,
  initialCreating = false,
  onConfigured,
  onSavingChange,
  target,
}: {
  api: SharedWorkspaceApi
  projectId: string
  translate: CollaborationTranslate
  onConfigureEnvironments(): void
  initialCreating?: boolean
  onConfigured?(profile: WorkspaceRuntimeProfile): Promise<void>
  onSavingChange?(saving: boolean): void
  target?: ProfileConfigurationTarget
}) {
  const revision = useRuntimeConfigurationRevision()
  const configureRuntime = useRuntimeConfiguration()
  const resource = useMemo(
    () => createProjectRuntimeSettingsResource(api, projectId, target),
    [api, projectId, target]
  )
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener, revision),
    [resource, revision]
  )
  const snapshot = useSyncExternalStore(subscribe, resource.getSnapshot, resource.getSnapshot)
  const data = snapshot.data
  const catalog = data?.catalog ?? null
  const profiles = catalog?.runtimeProfiles ?? []
  const defaultId = data?.defaultId ?? null
  const [selectedId, setSelectedId] = useState('')
  const [creating, setCreating] = useState(initialCreating)
  const [name, setName] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [modelIndex, setModelIndex] = useState('')
  const loading = snapshot.status === 'idle' || snapshot.status === 'loading'
  const [saving, setSaving] = useState(false)
  const [actionError, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const [observed, setObserved] = useState({
    resource,
    revision,
    initialCreating,
    readId: undefined as symbol | undefined,
  })
  if (observed.resource !== resource) {
    setObserved({ resource, revision, initialCreating, readId: undefined })
    setSelectedId('')
    setCreating(initialCreating)
    setName('')
    setDeviceId('')
    setModelIndex('')
    setError('')
    setSaved(false)
  } else if (observed.revision !== revision) {
    setObserved({ ...observed, revision })
    setError('')
  } else if (
    data &&
    (observed.readId !== data.readId || observed.initialCreating !== initialCreating)
  ) {
    setObserved({ resource, revision, initialCreating, readId: data.readId })
    setSelectedId(data.defaultId ?? '')
    if (initialCreating)
      setCreating(
        !complete(data.catalog.runtimeProfiles?.find(profile => profile.id === data.defaultId))
      )
  }
  const error =
    actionError ||
    (snapshot.status === 'error'
      ? snapshot.error instanceof RuntimeCatalogUnavailableError
        ? t('runtimeSettings.unavailable', '当前客户端不支持配置执行环境')
        : snapshot.error instanceof Error
          ? snapshot.error.message
          : t('runtimeSettings.loadFailed', '加载执行配置失败')
      : '')
  const load = useCallback(async () => {
    setError('')
    await resource.reload()
  }, [resource])

  const current = profiles.find(profile => profile.id === defaultId)
  const selected = profiles.find(profile => profile.id === selectedId)
  const environment = catalog?.environments.find(item => item.deviceId === deviceId)
  const model = modelIndex === '' ? undefined : catalog?.models[Number(modelIndex)]
  const models =
    catalog?.models.flatMap((item, index) =>
      environment?.executionEnvironment === 'cloud' && item.type === 'runtime'
        ? []
        : [{ ...item, index }]
    ) ?? []

  async function save() {
    if (saving || (creating ? !name.trim() || !environment || !model : !complete(selected))) return
    setSaving(true)
    onSavingChange?.(true)
    setError('')
    setSaved(false)
    try {
      let profile = selected
      if (creating && environment && model) {
        profile = await api.runtimeProfiles.create({
          name: name.trim(),
          executionEnvironment: environment.executionEnvironment,
          executionDeviceId: environment.deviceId,
          model: model.name,
          modelType: model.type,
          modelOptions: model.options,
        })
        if (!resource.isActive()) return
        resource.update(value =>
          value
            ? {
                ...value,
                catalog: {
                  ...value.catalog,
                  runtimeProfiles: [...(value.catalog.runtimeProfiles ?? []), profile!],
                },
              }
            : value
        )
        setSelectedId(profile.id)
        setCreating(false)
      }
      if (!profile) return
      if (target) {
        await target.apply(profile)
      } else {
        const binding = await api.runtimeProfiles.setProjectDefault(projectId, profile.id)
        if (!resource.isActive()) return
        resource.update(value =>
          value ? { ...value, defaultId: binding.runtimeProfileId } : value
        )
      }
      if (!resource.isActive()) return
      await onConfigured?.(profile)
      if (resource.isActive()) setSaved(true)
    } catch (cause) {
      if (!resource.isActive()) return
      setError(
        cause instanceof Error ? cause.message : t('runtimeSettings.saveFailed', '保存执行配置失败')
      )
    } finally {
      setSaving(false)
      onSavingChange?.(false)
    }
  }

  const controlClass =
    'h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm md:h-9'
  return (
    <section className="mt-6 border-t border-border pt-5" data-testid="project-runtime-settings">
      <h2 className="text-heading-sm font-semibold">
        {target?.title ?? t('runtimeSettings.title', '我的默认执行配置')}
      </h2>
      <p className="mt-2 text-sm text-text-muted">
        {target?.description ??
          t(
            'runtimeSettings.description',
            'AI 调度器使用这里的设备和模型来拆分、分配和推进任务；步骤智能体仍使用各自的配置。此设置仅影响你在当前项目中的执行。'
          )}
      </p>
      {loading ? (
        <p className="mt-3 text-sm">{t('common.loading', '加载中…')}</p>
      ) : (
        <>
          {!target && !error && !complete(current) ? (
            <p
              role="alert"
              className="mt-3 text-sm text-text-secondary"
              data-testid="project-runtime-missing"
            >
              {t(
                'runtimeSettings.missing',
                '尚未配置完整的设备和模型，AI 调度器无法启动。请在下方选择或新建执行配置。'
              )}
              {!initialCreating && configureRuntime ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className="collaboration-secondary-button ml-2 min-h-11"
                  data-testid="project-runtime-configure"
                  onClick={() => configureRuntime()}
                >
                  {t('runtimeSettings.configure', '立即配置')}
                </ControlButton>
              ) : null}
            </p>
          ) : null}
          {current && complete(current) ? (
            <p className="mt-3 text-sm" data-testid="project-runtime-current">
              {current.name} · {current.executionDeviceId} · {current.model}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-sm">
              <span className="mb-1 block">{t('runtimeSettings.profile', '执行配置')}</span>
              <SelectRoot
                disabled={saving}
                value={String(selectedId)}
                onValueChange={selectedValue => {
                  if (selectedValue === null) return
                  setSelectedId(selectedValue)
                  setCreating(false)
                  setSaved(false)
                }}
              >
                <SelectTrigger className={controlClass} data-testid="project-runtime-profile" />
                <SelectContent>
                  <SelectItem value="">{t('runtimeSettings.select', '选择执行配置')}</SelectItem>
                  {profiles
                    .filter(profile => profile.status === 'active')
                    .map(profile => (
                      <SelectItem key={profile.id} value={String(profile.id)}>
                        {profile.name}
                        {complete(profile)
                          ? ''
                          : ` · ${t('runtimeSettings.incomplete', '缺少设备或模型')}`}
                      </SelectItem>
                    ))}
                </SelectContent>
              </SelectRoot>
            </label>
            <ControlButton
              variant="unstyled"
              className="collaboration-secondary-button min-h-11 md:min-h-9"
              type="button"
              data-testid="project-runtime-create"
              disabled={saving}
              onClick={() => {
                setCreating(true)
                setSaved(false)
                setError('')
                setName('')
                setDeviceId('')
                setModelIndex('')
              }}
            >
              {t('runtimeSettings.create', '新建配置')}
            </ControlButton>
          </div>
          {creating ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block">{t('runtimeSettings.name', '配置名称')}</span>
                <ControlInput
                  className={controlClass}
                  data-testid="project-runtime-name"
                  autoFocus={initialCreating}
                  value={name}
                  maxLength={100}
                  disabled={saving}
                  onChange={event => setName(event.target.value)}
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block">{t('runtimeSettings.device', '执行设备')}</span>
                <SelectRoot
                  disabled={saving}
                  value={String(deviceId)}
                  onValueChange={selectedValue => {
                    if (selectedValue === null) return
                    setDeviceId(selectedValue)
                    setModelIndex('')
                  }}
                >
                  <SelectTrigger className={controlClass} data-testid="project-runtime-device" />
                  <SelectContent>
                    <SelectItem value="">
                      {t('runtimeSettings.selectDevice', '选择执行设备')}
                    </SelectItem>
                    {catalog?.environments.map(item => (
                      <SelectItem key={item.deviceId} value={String(item.deviceId)}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </label>
              <label className="text-sm">
                <span className="mb-1 block">{t('runtimeSettings.model', '模型')}</span>
                <SelectRoot
                  disabled={saving || !environment}
                  value={String(modelIndex)}
                  onValueChange={selectedValue => {
                    if (selectedValue === null) return
                    return setModelIndex(selectedValue)
                  }}
                >
                  <SelectTrigger className={controlClass} data-testid="project-runtime-model" />
                  <SelectContent>
                    <SelectItem value="">{t('runtimeSettings.selectModel', '选择模型')}</SelectItem>
                    {models.map(item => (
                      <SelectItem key={item.index} value={String(item.index)}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </label>
              {!catalog?.environments.length ? (
                <div className="text-sm sm:col-span-2">
                  <p>
                    {t(
                      'runtimeSettings.noDevices',
                      '项目没有可用的在线执行设备。请先添加执行环境。'
                    )}
                  </p>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    className="mt-2 min-h-11 text-text-link md:min-h-9"
                    data-testid="project-runtime-configure-environments"
                    onClick={onConfigureEnvironments}
                  >
                    {t('runtimeSettings.configureEnvironments', '配置执行环境')}
                  </ControlButton>
                </div>
              ) : null}
            </div>
          ) : null}
          <ControlButton
            variant="unstyled"
            type="button"
            className="collaboration-primary-button mt-4 min-h-11 md:min-h-9"
            data-testid="project-runtime-save"
            disabled={
              saving ||
              (Boolean(target) && saved) ||
              (creating ? !name.trim() || !environment || !model : !complete(selected))
            }
            onClick={() => void save()}
          >
            {saving
              ? t('runtimeSettings.saving', '保存中…')
              : target
                ? target.saveLabel
                : creating
                  ? t('runtimeSettings.createAndUse', '创建并设为默认')
                  : t('runtimeSettings.use', '设为项目默认')}
          </ControlButton>
        </>
      )}
      {error ? (
        <div role="alert" className="mt-3 text-sm">
          <p>{error}</p>
          {!catalog ? (
            <ControlButton
              variant="unstyled"
              type="button"
              className="mt-2 min-h-11 md:min-h-9"
              data-testid="project-runtime-retry"
              onClick={() => void load()}
            >
              {t('common.retry', '重试')}
            </ControlButton>
          ) : null}
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="mt-3 text-sm">
          {target?.savedLabel ??
            t('runtimeSettings.saved', '已设为当前项目默认配置。可返回原页面继续操作。')}
        </p>
      ) : null}
    </section>
  )
}
