import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, RefreshCw, Server } from 'lucide-react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { ProjectSpaceDetailServiceMap } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getLocalExecutorStatus } from '@/tauri/localExecutor'
import type { DeviceInfo } from '@/types/devices'
import type { ProjectAutomationRule, ProjectAutomationRun } from '@/api/projectAutomations'
import type { LocatedProjectSpace } from './projectSpaceSelection'
import { isExecutionActive, isExecutionCancellable } from './executionStatus'

interface ProjectSpaceSettingsProps {
  deviceApi?: WorkbenchServices['deviceApi']
  projects?: LocatedProjectSpace[]
  projectServices?: ProjectSpaceDetailServiceMap
}

interface GlobalAutomationRow {
  project: LocatedProjectSpace
  rule: ProjectAutomationRule
  runs: ProjectAutomationRun[]
}

const ROLE_LEVEL: Record<string, number> = {
  Owner: 0,
  Maintainer: 1,
  Developer: 2,
  Reporter: 3,
  RestrictedAnalyst: 4,
}

function projectRoleLevel(project: LocatedProjectSpace): number {
  return ROLE_LEVEL[project.access_role ?? 'Owner'] ?? 4
}

const MAX_CONCURRENT_TASKS = 20
const CREATE_PROJECT_EXAMPLE = `curl -X POST 'https://<host>/api/v1/cloud-projects' \\
  -H 'Content-Type: application/json' \\
  -H 'X-API-Key: wg-<personal-api-key>' \\
  -d '{"project_key":"OPS","name":"运维看板","description":"通过 API 创建"}'`
const CREATE_TASK_EXAMPLE = `curl -X POST 'https://<host>/api/v1/cloud-projects/<project-id>/loop-items' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer wg-<personal-api-key>' \\
  -d '{"title":"检查云端运行状态","description":"通过 API 创建","priority":"high","tags":["api"]}'`

function deviceIsCurrent(device: DeviceInfo, localDeviceId: string | null): boolean {
  if (localDeviceId) {
    return (
      device.device_id === localDeviceId ||
      device.app_device_id === localDeviceId ||
      device.socket_device_id === localDeviceId
    )
  }
  return device.device_type === 'app'
}

function CodeExample({ testId, value }: { testId: string; value: string }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)

  return (
    <div className="relative mt-3 overflow-hidden rounded-xl border border-border bg-muted/30">
      <pre className="overflow-x-auto p-4 pr-12 text-code text-text-secondary">
        <code>{value}</code>
      </pre>
      <button
        type="button"
        data-testid={testId}
        aria-label={t('workbench.project_settings_copy_example')}
        onClick={() => {
          void copyTextToClipboard(value).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }}
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  )
}

export function ProjectSpaceSettings({
  deviceApi,
  projects = [],
  projectServices,
}: ProjectSpaceSettingsProps) {
  const { t } = useTranslation('common')
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingDeviceId, setSavingDeviceId] = useState<string | null>(null)
  const [automations, setAutomations] = useState<GlobalAutomationRow[]>([])
  const [automationBusy, setAutomationBusy] = useState<string | null>(null)
  const [automationError, setAutomationError] = useState('')

  const loadAutomations = useCallback(async () => {
    const results = await Promise.allSettled(
      projects
        .filter(project => projectRoleLevel(project) <= ROLE_LEVEL.Reporter)
        .map(async project => {
          const api = projectServices?.[project.location]?.projectAutomationApi
          if (!api) return []
          const rules = await api.list(String(project.id))
          return Promise.all(
            rules.map(async rule => ({
              project,
              rule,
              runs: await api.listRuns(String(project.id), rule.id),
            }))
          )
        })
    )
    setAutomations(results.flatMap(result => (result.status === 'fulfilled' ? result.value : [])))
    const failures = results.filter(result => result.status === 'rejected')
    setAutomationError(
      failures.length > 0
        ? t('workbench.project_settings_automation_partial_error', { count: failures.length })
        : ''
    )
  }, [projectServices, projects, t])

  const loadDevices = useCallback(async () => {
    if (!deviceApi) {
      setDevices([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [listed, localStatus] = await Promise.all([
        deviceApi.listDevices(),
        getLocalExecutorStatus().catch(() => null),
      ])
      setDevices(listed)
      setLocalDeviceId(localStatus?.deviceId ?? null)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.project_settings_devices_error')
      )
    } finally {
      setLoading(false)
    }
  }, [deviceApi, t])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadDevices()
    })
    return () => {
      active = false
    }
  }, [loadDevices])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAutomations().catch(cause =>
        setAutomationError(cause instanceof Error ? cause.message : String(cause))
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [loadAutomations])

  async function updateAutomation(row: GlobalAutomationRow, enabled: boolean) {
    const api = projectServices?.[row.project.location]?.projectAutomationApi
    if (!api) return
    setAutomationBusy(row.rule.id)
    try {
      await api.update(String(row.project.id), row.rule.id, {
        version: row.rule.version,
        enabled,
      })
      await loadAutomations()
      setAutomationError('')
    } catch (cause) {
      setAutomationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAutomationBusy(null)
    }
  }

  async function cancelAutomationRun(row: GlobalAutomationRow, run: ProjectAutomationRun) {
    const api = projectServices?.[row.project.location]?.projectAutomationApi
    if (!api) return
    setAutomationBusy(run.id)
    try {
      await api.cancelRun(String(row.project.id), run.id)
      await loadAutomations()
      setAutomationError('')
    } catch (cause) {
      setAutomationError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAutomationBusy(null)
    }
  }

  const orderedDevices = useMemo(
    () =>
      [...devices].sort((left, right) => {
        const currentOrder =
          Number(deviceIsCurrent(right, localDeviceId)) -
          Number(deviceIsCurrent(left, localDeviceId))
        return currentOrder || left.name.localeCompare(right.name)
      }),
    [devices, localDeviceId]
  )
  const totalCapacity = orderedDevices.reduce(
    (total, device) =>
      device.status === 'offline' ? total : total + Math.max(1, device.slot_max ?? 1),
    0
  )
  const orderedAutomations = useMemo(
    () =>
      [...automations].sort((left, right) => {
        const enabledOrder = Number(left.rule.enabled) - Number(right.rule.enabled)
        if (enabledOrder !== 0) return enabledOrder
        const projectOrder = left.project.name.localeCompare(right.project.name)
        return projectOrder || left.rule.name.localeCompare(right.rule.name)
      }),
    [automations]
  )

  async function updateLimit(device: DeviceInfo, maxConcurrentTasks: number) {
    if (!deviceApi) return
    setSavingDeviceId(device.device_id)
    setError(null)
    try {
      const settings = await deviceApi.updateRuntimeSettings(device.device_id, maxConcurrentTasks)
      setDevices(current =>
        current.map(entry =>
          entry.device_id === device.device_id
            ? {
                ...entry,
                slot_max: settings.max_concurrent_tasks,
                slot_used: settings.active_tasks,
              }
            : entry
        )
      )
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('workbench.project_settings_devices_error')
      )
    } finally {
      setSavingDeviceId(null)
    }
  }

  return (
    <div data-testid="project-space-settings" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-16 pt-14">
        <h1 className="text-heading-lg font-medium text-text-primary">
          {t('workbench.project_settings_title')}
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          {t('workbench.project_settings_description')}
        </p>

        <section className="mt-10" data-testid="project-space-device-concurrency">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-heading-sm font-medium text-text-primary">
                {t('workbench.project_settings_concurrency_title')}
              </h2>
              <p className="mt-1 text-sm text-text-muted">
                {t('workbench.project_settings_concurrency_description')}
              </p>
            </div>
            <button
              type="button"
              data-testid="project-settings-refresh-devices"
              aria-label={t('workbench.project_settings_refresh_devices')}
              onClick={() => void loadDevices()}
              disabled={loading}
              className="flex h-8 items-center gap-2 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-40"
            >
              <RefreshCw className="h-4 w-4" />
              {t('workbench.project_settings_refresh_devices')}
            </button>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm">
              <span className="text-text-secondary">
                {t('workbench.project_settings_total_capacity')}
              </span>
              <span data-testid="project-settings-total-capacity" className="font-medium">
                {totalCapacity}
              </span>
            </div>
            {loading ? (
              <div className="px-4 py-8 text-center text-sm text-text-muted">
                {t('workbench.project_settings_loading_devices')}
              </div>
            ) : orderedDevices.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-muted">
                {t('workbench.project_settings_no_devices')}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {orderedDevices.map(device => {
                  const current = deviceIsCurrent(device, localDeviceId)
                  const offline = device.status === 'offline'
                  return (
                    <div
                      key={device.device_id}
                      data-testid={`project-settings-device-${device.device_id}`}
                      className="flex min-h-16 items-center gap-3 px-4 py-3"
                    >
                      <Server className="h-4 w-4 shrink-0 text-text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{device.name}</span>
                          <span className="text-xs text-text-muted">
                            {current
                              ? t('workbench.project_settings_current_device')
                              : t('workbench.project_settings_other_device')}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-text-muted">
                          {offline
                            ? t('workbench.project_settings_device_offline')
                            : t('workbench.project_settings_device_usage', {
                                used: device.slot_used ?? 0,
                                total: device.slot_max ?? 1,
                              })}
                        </p>
                      </div>
                      <select
                        data-testid={`project-settings-device-limit-${device.device_id}`}
                        aria-label={t('workbench.project_settings_device_limit', {
                          name: device.name,
                        })}
                        value={Math.max(1, device.slot_max ?? 1)}
                        disabled={offline || savingDeviceId === device.device_id}
                        onChange={event => void updateLimit(device, Number(event.target.value))}
                        className="h-8 w-20 rounded-md border border-border bg-background px-2 text-sm disabled:opacity-40"
                      >
                        {Array.from({ length: MAX_CONCURRENT_TASKS }, (_, index) => index + 1).map(
                          value => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          )
                        )}
                      </select>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {error ? (
            <p
              data-testid="project-settings-device-error"
              className="mt-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
        </section>

        <section className="mt-12" data-testid="project-space-automation-management">
          <h2 className="text-heading-sm font-medium text-text-primary">
            {t('workbench.project_settings_automation_title')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {t('workbench.project_settings_automation_description')}
          </p>
          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-background">
            {orderedAutomations.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-muted">
                {t('workbench.project_settings_no_automations')}
              </div>
            ) : (
              <div
                data-testid="project-settings-automation-scroll-area"
                className="max-h-80 divide-y divide-border overflow-y-auto overscroll-contain"
              >
                {orderedAutomations.map(row => {
                  const activeRun = row.runs.find(run => isExecutionActive(run.status))
                  const roleLevel = projectRoleLevel(row.project)
                  return (
                    <div
                      key={`${row.project.location}:${row.rule.id}`}
                      className="flex items-center gap-4 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{row.rule.name}</div>
                        <div className="mt-0.5 text-xs text-text-muted">
                          {row.project.name} ·{' '}
                          {activeRun?.status ?? row.rule.lastRunStatus ?? 'idle'}
                        </div>
                      </div>
                      {activeRun &&
                      roleLevel <= ROLE_LEVEL.Developer &&
                      isExecutionCancellable(activeRun.status) ? (
                        <button
                          type="button"
                          data-testid={`project-settings-cancel-run-${activeRun.id}`}
                          disabled={automationBusy === activeRun.id}
                          onClick={() => void cancelAutomationRun(row, activeRun)}
                          className="h-8 rounded-lg px-3 text-sm text-destructive hover:bg-muted disabled:opacity-40"
                        >
                          {t('workbench.project_settings_cancel_run')}
                        </button>
                      ) : null}
                      {roleLevel <= ROLE_LEVEL.Maintainer ? (
                        <button
                          type="button"
                          data-testid={`project-settings-toggle-automation-${row.rule.id}`}
                          disabled={automationBusy === row.rule.id}
                          onClick={() => void updateAutomation(row, !row.rule.enabled)}
                          className="h-8 rounded-lg px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-40"
                        >
                          {row.rule.enabled
                            ? t('workbench.project_settings_disable_automation')
                            : t('workbench.project_settings_enable_automation')}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {automationError ? (
            <p className="mt-3 text-sm text-destructive">{automationError}</p>
          ) : null}
        </section>

        <section className="mt-12" data-testid="project-space-api-wiki">
          <h2 className="text-heading-sm font-medium text-text-primary">
            {t('workbench.project_settings_api_title')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {t('workbench.project_settings_api_description')}
          </p>
          <div className="mt-5 space-y-8">
            <div>
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.project_settings_create_project')}
              </h3>
              <p className="mt-1 text-sm text-text-muted">
                <code className="text-code">POST /api/v1/cloud-projects</code>
              </p>
              <CodeExample
                testId="project-settings-copy-create-project"
                value={CREATE_PROJECT_EXAMPLE}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.project_settings_create_task')}
              </h3>
              <p className="mt-1 text-sm text-text-muted">
                <code className="text-code">
                  POST /api/v1/cloud-projects/&lt;project-id&gt;/loop-items
                </code>
              </p>
              <CodeExample testId="project-settings-copy-create-task" value={CREATE_TASK_EXAMPLE} />
            </div>
          </div>
          <p className="mt-5 text-sm text-text-muted">{t('workbench.project_settings_api_auth')}</p>
        </section>
      </div>
    </div>
  )
}
