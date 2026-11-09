import { useContext, useEffect, useState } from 'react'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeSettings } from '@/types/api'
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
  const [runtimeSettings, setRuntimeSettings] = useState(DEFAULT_RUNTIME_SETTINGS)
  const [loadedScope, setLoadedScope] = useState<{
    api: typeof runtimeWorkApi
    revision: number
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reload, setReload] = useState(0)

  const loading = loadedScope?.api !== runtimeWorkApi || loadedScope?.revision !== reload

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => runtimeWorkApi?.getRuntimeSettings())
      .then(settings => {
        if (!cancelled) {
          if (settings) setRuntimeSettings(settings)
          setLoadFailed(false)
          setError(null)
        }
      })
      .catch(loadError => {
        console.error('[Wework] Failed to load runtime concurrency settings', loadError)
        if (!cancelled) {
          setLoadFailed(true)
          setError(t('workbench.general_settings_load_failed'))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadedScope({ api: runtimeWorkApi, revision: reload })
      })
    return () => {
      cancelled = true
    }
  }, [runtimeWorkApi, reload, t])

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
          control={
            <select
              data-testid={setting.testId}
              value={runtimeSettings[setting.key]}
              disabled={loading || saving || loadFailed || !runtimeWorkApi}
              aria-label={t(`workbench.${setting.label}`)}
              onChange={event => {
                void saveConcurrency(setting.key, Number(event.target.value))
              }}
              className="h-8 w-24 rounded-md border border-border bg-background px-2 text-sm text-text-primary max-md:h-11"
            >
              {Array.from({ length: MAX_CONCURRENT_TASKS_LIMIT }, (_, index) => index + 1).map(
                value => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                )
              )}
            </select>
          }
        />
      ))}
      {error && !loading && (
        <div role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
          {loadFailed && (
            <button
              type="button"
              data-testid="general-concurrency-retry-button"
              onClick={() => {
                setError(null)
                setLoadFailed(false)
                setReload(value => value + 1)
              }}
              className="ml-2 min-h-6 underline max-md:min-h-11"
            >
              {t('workbench.retry')}
            </button>
          )}
        </div>
      )}
    </>
  )
}
