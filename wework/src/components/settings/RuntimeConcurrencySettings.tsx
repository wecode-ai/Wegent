import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeSettings } from '@/types/api'
import { createAsyncResource, getIdleResourceSnapshot } from '@wegent/chat-core/async-resource'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { SettingsRow } from './settings-ui'

const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  maxConcurrentTasks: 10,
  maxConcurrentStandInTasks: 10,
  maxConcurrentAgentTasks: 10,
}
const CONCURRENCY_SETTINGS = [
  {
    key: 'maxConcurrentTasks',
    label: 'general_settings_max_concurrent_tasks',
    testId: 'general-max-concurrent-tasks-select',
  },
  {
    key: 'maxConcurrentStandInTasks',
    label: 'general_settings_max_concurrent_stand_in_tasks',
    testId: 'general-max-concurrent-stand-in-tasks-select',
  },
  {
    key: 'maxConcurrentAgentTasks',
    label: 'general_settings_max_concurrent_agent_tasks',
    testId: 'general-max-concurrent-agent-tasks-select',
  },
] as const
const MAX_CONCURRENT_TASKS_LIMIT = 20

export function RuntimeConcurrencySettings() {
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const runtimeWorkApi = workbench?.services?.runtimeWorkApi
  const resource = useMemo(
    () =>
      createAsyncResource<RuntimeSettings>(
        'runtime-concurrency',
        async () => (await runtimeWorkApi?.getRuntimeSettings()) ?? DEFAULT_RUNTIME_SETTINGS,
        {
          initialData: DEFAULT_RUNTIME_SETTINGS,
          refreshOnSubscribe: true,
          failure: error =>
            console.error('[Wework] Failed to load runtime concurrency settings', error),
        }
      ),
    [runtimeWorkApi]
  )
  const query = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const [form, setForm] = useState({ resource, saving: false, error: null as string | null })
  if (form.resource !== resource) setForm({ resource, saving: false, error: null })
  const setSaving = (saving: boolean) =>
    setForm(current => (current.resource === resource ? { ...current, saving } : current))
  const setError = (error: string | null) =>
    setForm(current => (current.resource === resource ? { ...current, error } : current))
  const runtimeSettings = query.data ?? DEFAULT_RUNTIME_SETTINGS
  const setRuntimeSettings = (
    change: RuntimeSettings | ((previous: RuntimeSettings) => RuntimeSettings)
  ) => {
    resource.update(previous =>
      typeof change === 'function' ? change(previous ?? DEFAULT_RUNTIME_SETTINGS) : change
    )
  }
  const loading = query.status === 'idle' || query.status === 'loading'
  const loadFailed = query.status === 'error'
  const saving = form.saving
  const error = form.error ?? (loadFailed ? t('workbench.general_settings_load_failed') : null)

  const saveConcurrency = async (key: keyof RuntimeSettings, value: number) => {
    const previousValue = runtimeSettings
    setRuntimeSettings({ ...runtimeSettings, [key]: value })
    setSaving(true)
    setError(null)
    try {
      const settings = await runtimeWorkApi!.updateRuntimeSettings({
        [key]: value,
      })
      setRuntimeSettings(previous => ({ ...previous, ...settings }))
      try {
        await workbench?.refreshWorkLists()
      } catch (refreshError) {
        console.warn(
          '[Wework] Failed to refresh runtime tasks after updating concurrency settings',
          refreshError
        )
      }
    } catch (saveError) {
      console.error('[Wework] Failed to update runtime concurrency settings', saveError)
      setRuntimeSettings(previousValue)
      setError(t('workbench.general_settings_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {CONCURRENCY_SETTINGS.map(setting => (
        <SettingsRow
          key={setting.key}
          label={t(`workbench.${setting.label}`)}
          description={t(`workbench.${setting.label}_description`)}
          className={'py-4'}
          labelClassName={'font-normal'}
          children={
            <SelectRoot
              value={normalizeSelectValue(runtimeSettings[setting.key])}
              disabled={loading || saving || loadFailed || !runtimeWorkApi}
              onValueChange={selectedValue => {
                if (selectedValue === null) return
                void saveConcurrency(setting.key, Number(selectedValue))
              }}
            >
              <SelectTrigger
                data-testid={setting.testId}
                aria-label={t(`workbench.${setting.label}`)}
                className="w-24"
              />
              <SelectContent>
                {Array.from({ length: MAX_CONCURRENT_TASKS_LIMIT }, (_, index) => index + 1).map(
                  value => (
                    <SelectItem key={value} value={String(value)}>
                      {value}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </SelectRoot>
          }
        />
      ))}
      {error && !loading && (
        <div role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
          {loadFailed && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="general-concurrency-retry-button"
              onClick={() => {
                setError(null)
                void resource.reload()
              }}
              className="ml-2 min-h-6 underline max-md:min-h-11"
            >
              {t('workbench.retry')}
            </ControlButton>
          )}
        </div>
      )}
    </>
  )
}
