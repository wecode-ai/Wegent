import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Clock3, Loader2, Pause, Play, Plus, Trash2 } from 'lucide-react'
import type {
  ProjectAutomationInput,
  ProjectAutomationRule,
  ProjectAutomationRun,
  createProjectAutomationApi,
} from '@/api/projectAutomations'
import type { ProjectChatAgent, createProjectChatAgentApi } from '@/api/projectChatAgents'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import { CloudTodoModal } from './CloudTodoModal'

type AutomationApi = ReturnType<typeof createProjectAutomationApi>
type AgentApi = ReturnType<typeof createProjectChatAgentApi>
type ScheduleFrequency = 'daily' | 'weekdays' | 'weekly'

interface VisualSchedule {
  frequency: ScheduleFrequency
  time: string
  weekday: string
}

const defaultSchedule = (): VisualSchedule => ({ frequency: 'daily', time: '03:00', weekday: '1' })

const validTimePart = (value: string | undefined, fallback: number, maximum: number): number => {
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback
}

const scheduleToCron = ({ frequency, time, weekday }: VisualSchedule): string => {
  const [hour = '3', minute = '0'] = time.split(':')
  const dayOfWeek = frequency === 'weekdays' ? '1-5' : frequency === 'weekly' ? weekday : '*'
  return `${validTimePart(minute, 0, 59)} ${validTimePart(hour, 3, 23)} * * ${dayOfWeek}`
}

const cronToSchedule = (cronExpression: string): VisualSchedule => {
  const [minute = '0', hour = '3', , , dayOfWeek = '*'] = cronExpression.trim().split(/\s+/)
  const time = `${String(validTimePart(hour, 3, 23)).padStart(2, '0')}:${String(
    validTimePart(minute, 0, 59)
  ).padStart(2, '0')}`
  if (dayOfWeek === '1-5') return { frequency: 'weekdays', time, weekday: '1' }
  if (/^[0-6]$/.test(dayOfWeek)) return { frequency: 'weekly', time, weekday: dayOfWeek }
  return { frequency: 'daily', time, weekday: '1' }
}

const weekdayOptions = (t: (key: string) => string) => [
  { value: '1', label: t('workbench.project_automation_monday') },
  { value: '2', label: t('workbench.project_automation_tuesday') },
  { value: '3', label: t('workbench.project_automation_wednesday') },
  { value: '4', label: t('workbench.project_automation_thursday') },
  { value: '5', label: t('workbench.project_automation_friday') },
  { value: '6', label: t('workbench.project_automation_saturday') },
  { value: '0', label: t('workbench.project_automation_sunday') },
]

const formatSchedule = (schedule: VisualSchedule, t: (key: string) => string): string => {
  const frequency =
    schedule.frequency === 'daily'
      ? t('workbench.project_automation_daily')
      : schedule.frequency === 'weekdays'
        ? t('workbench.project_automation_weekdays')
        : `${t('workbench.project_automation_weekly')} · ${
            weekdayOptions(t).find(day => day.value === schedule.weekday)?.label ?? ''
          }`
  return `${frequency} ${schedule.time}`
}

const timezoneOptions = (current: string): string[] =>
  Array.from(
    new Set([current, 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC'])
  ).filter(Boolean)

const defaultInput = (): ProjectAutomationInput => ({
  name: '',
  prompt: '',
  cronExpression: '0 3 * * *',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  agentId: '',
  enabled: true,
})

export function ProjectAutomationRulesSection({
  projectId,
  api,
  agentApi,
  canManage,
  deviceApi,
  onOpenTask,
}: {
  projectId: string
  api?: AutomationApi
  agentApi?: AgentApi
  canManage: boolean
  deviceApi?: { listDevices: () => Promise<DeviceInfo[]> }
  onOpenTask?: (taskId: string) => void
}) {
  const { t } = useTranslation('common')
  const [rules, setRules] = useState<ProjectAutomationRule[]>([])
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [runs, setRuns] = useState<ProjectAutomationRun[]>([])
  const [selected, setSelected] = useState<ProjectAutomationRule | null>(null)
  const [draft, setDraft] = useState<ProjectAutomationInput | null>(null)
  const [schedule, setSchedule] = useState<VisualSchedule>(defaultSchedule)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!api || !agentApi) return
    try {
      const [nextRules, nextAgents, nextDevices] = await Promise.all([
        api.list(projectId),
        agentApi.list(projectId),
        deviceApi?.listDevices() ?? Promise.resolve([]),
      ])
      setRules(nextRules)
      setAgents(nextAgents.filter(agent => agent.status === 'active'))
      setDevices(nextDevices)
      setSelected(current =>
        current ? (nextRules.find(rule => rule.id === current.id) ?? null) : null
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }, [agentApi, api, deviceApi, projectId])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const selectRule = async (rule: ProjectAutomationRule) => {
    setSelected(rule)
    setDraft({
      name: rule.name,
      prompt: rule.prompt,
      cronExpression: rule.cronExpression,
      timezone: rule.timezone,
      agentId: rule.agentId,
      enabled: rule.enabled,
    })
    setSchedule(cronToSchedule(rule.cronExpression))
    if (!api) return
    try {
      setError('')
      setRuns(await api.listRuns(projectId, rule.id))
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError))
    }
  }

  const createRule = () => {
    const input = defaultInput()
    input.agentId = agents[0]?.id ?? ''
    setSelected(null)
    setRuns([])
    setDraft(input)
    setSchedule(defaultSchedule())
  }

  const save = async () => {
    if (!api || !draft) return
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.agentId) {
      setError(t('workbench.project_automation_required_fields'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const input = { ...draft, cronExpression: scheduleToCron(schedule) }
      const rule = selected
        ? await api.update(projectId, selected.id, { ...input, version: selected.version })
        : await api.create(projectId, input)
      await load()
      await selectRule(rule)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (rule: ProjectAutomationRule) => {
    if (!api || !window.confirm(t('workbench.project_automation_delete_confirm'))) return
    setBusy(true)
    setError('')
    try {
      await api.delete(projectId, rule.id)
      setSelected(null)
      setDraft(null)
      setRuns([])
      await load()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError))
    } finally {
      setBusy(false)
    }
  }

  const runNow = async (rule: ProjectAutomationRule) => {
    if (!api) return
    setBusy(true)
    setError('')
    try {
      await api.runNow(projectId, rule.id)
      setRuns(await api.listRuns(projectId, rule.id))
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setBusy(false)
    }
  }

  const cancelRun = async (runId: string) => {
    if (!api || !selected) return
    setBusy(true)
    setError('')
    try {
      await api.cancelRun(projectId, runId)
      setRuns(await api.listRuns(projectId, selected.id))
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = useMemo(
    () => ({
      pending: t('workbench.project_automation_pending'),
      waiting_device: t('workbench.project_automation_waiting_device'),
      running: t('workbench.project_automation_running'),
      succeeded: t('workbench.project_automation_succeeded'),
      failed: t('workbench.project_automation_failed'),
      skipped: t('workbench.project_automation_skipped'),
      cancelled: t('workbench.project_automation_cancelled'),
    }),
    [t]
  )

  if (!api || !agentApi) return null

  return (
    <section data-testid="project-automation-rules" className="border-b border-border pb-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-heading-md font-semibold">
            {t('workbench.project_automation_rules_title')}
          </h3>
          <p className="mt-1 text-sm text-text-muted">
            {t('workbench.project_automation_rules_description')}
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            data-testid="project-automation-create"
            onClick={createRule}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
          >
            <Plus className="h-4 w-4" />
            {t('workbench.project_automation_create')}
          </button>
        ) : null}
      </div>

      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      <div className="space-y-2" data-testid="project-automation-rule-list">
        {rules.length ? (
          rules.map(rule => (
            <button
              key={rule.id}
              type="button"
              data-testid={`project-automation-rule-${rule.id}`}
              onClick={() => void selectRule(rule)}
              className="flex w-full items-center gap-4 rounded-xl border border-border px-4 py-3 text-left transition hover:border-text-tertiary hover:bg-surface"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <CalendarClock className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{rule.name}</span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {formatSchedule(cronToSchedule(rule.cronExpression), t)} · {rule.agentName}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-text-muted">
                <span className="block">
                  {rule.lastRunStatus
                    ? statusLabel[rule.lastRunStatus]
                    : rule.nextRunAt
                      ? new Date(rule.nextRunAt).toLocaleString()
                      : t('workbench.project_automation_disabled')}
                </span>
                <span className="mt-1 block">
                  {rule.enabled
                    ? t('workbench.project_automation_enabled')
                    : t('workbench.project_automation_disabled')}
                </span>
              </span>
            </button>
          ))
        ) : (
          <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-border px-4 text-center">
            <CalendarClock className="mb-2 h-5 w-5 text-text-tertiary" />
            <p className="text-sm text-text-muted">{t('workbench.project_automation_empty')}</p>
          </div>
        )}
      </div>

      {draft ? (
        <CloudTodoModal
          title={
            selected
              ? t('workbench.project_automation_edit')
              : t('workbench.project_automation_new')
          }
          width="wide"
          onClose={() => {
            setDraft(null)
            setSelected(null)
          }}
        >
          <div className="overflow-y-auto px-5 pb-5 pt-4" data-testid="project-automation-editor">
            <div className="space-y-5">
              <label className="block text-sm font-medium">
                {t('workbench.project_automation_name')}
                <input
                  data-testid="project-automation-name"
                  value={draft.name}
                  onChange={event => setDraft({ ...draft, name: event.target.value })}
                  placeholder={t('workbench.project_automation_name')}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal outline-none focus:border-text-tertiary"
                />
              </label>
              <label className="block text-sm font-medium">
                {t('workbench.project_automation_prompt')}
                <textarea
                  data-testid="project-automation-prompt"
                  value={draft.prompt}
                  onChange={event => setDraft({ ...draft, prompt: event.target.value })}
                  placeholder={t('workbench.project_automation_prompt')}
                  className="mt-2 min-h-28 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm font-normal outline-none focus:border-text-tertiary"
                />
              </label>

              <div className="rounded-xl bg-surface p-4">
                <h5 className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <Clock3 className="h-4 w-4" />
                  {t('workbench.project_automation_schedule')}
                </h5>
                <div className="space-y-3">
                  <label className="block text-xs text-text-muted">
                    {t('workbench.project_automation_frequency')}
                    <select
                      data-testid="project-automation-frequency"
                      value={schedule.frequency}
                      onChange={event =>
                        setSchedule({
                          ...schedule,
                          frequency: event.target.value as ScheduleFrequency,
                        })
                      }
                      className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none"
                    >
                      <option value="daily">{t('workbench.project_automation_daily')}</option>
                      <option value="weekdays">{t('workbench.project_automation_weekdays')}</option>
                      <option value="weekly">{t('workbench.project_automation_weekly')}</option>
                    </select>
                  </label>
                  {schedule.frequency === 'weekly' ? (
                    <label className="block text-xs text-text-muted">
                      {t('workbench.project_automation_weekday')}
                      <select
                        data-testid="project-automation-weekday"
                        value={schedule.weekday}
                        onChange={event =>
                          setSchedule({ ...schedule, weekday: event.target.value })
                        }
                        className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none"
                      >
                        {weekdayOptions(t).map(day => (
                          <option key={day.value} value={day.value}>
                            {day.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label className="block text-xs text-text-muted">
                    {t('workbench.project_automation_time')}
                    <input
                      type="time"
                      step="900"
                      data-testid="project-automation-time"
                      value={schedule.time}
                      onChange={event => setSchedule({ ...schedule, time: event.target.value })}
                      className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none"
                    />
                  </label>
                  <label className="block text-xs text-text-muted">
                    {t('workbench.project_automation_timezone')}
                    <select
                      data-testid="project-automation-timezone"
                      value={draft.timezone}
                      onChange={event => setDraft({ ...draft, timezone: event.target.value })}
                      className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none"
                    >
                      {timezoneOptions(draft.timezone).map(timezone => (
                        <option key={timezone} value={timezone}>
                          {timezone}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <label className="block text-sm font-medium">
                {t('workbench.project_automation_robot')}
                <select
                  data-testid="project-automation-agent"
                  value={draft.agentId}
                  onChange={event => setDraft({ ...draft, agentId: event.target.value })}
                  className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal text-text-primary outline-none"
                >
                  <option value="">{t('workbench.project_automation_select_robot')}</option>
                  {agents.map(agent => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {agent.executionEnvironment}
                      {agent.executionEnvironment === 'local'
                        ? ` · ${
                            devices.find(device => device.device_id === agent.executionDeviceId)
                              ?.status ?? 'offline'
                          }`
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={event => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                  {t('workbench.project_automation_enabled')}
                </label>
                <div className="flex gap-2">
                  {selected ? (
                    <>
                      <button
                        type="button"
                        data-testid="project-automation-run-now"
                        disabled={busy}
                        onClick={() => void runNow(selected)}
                        className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm hover:bg-surface disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        {t('workbench.project_automation_run_now')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(selected)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-red-600 hover:bg-red-500/5"
                        aria-label={t('workbench.delete')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    data-testid="project-automation-save"
                    disabled={busy || !draft.name.trim() || !draft.prompt.trim() || !draft.agentId}
                    onClick={() => void save()}
                    className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background disabled:opacity-50"
                  >
                    {t('workbench.save')}
                  </button>
                </div>
              </div>
            </div>

            {selected && runs.length ? (
              <div className="border-t border-border pt-4" data-testid="project-automation-runs">
                <h5 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Clock3 className="h-4 w-4" />
                  {t('workbench.project_automation_runs')}
                </h5>
                <div className="space-y-1">
                  {runs.slice(0, 5).map(run => (
                    <div key={run.id} className="flex min-h-8 items-center gap-2 text-xs">
                      <span className="w-24 text-text-muted">{statusLabel[run.status]}</span>
                      <span className="flex-1 truncate text-text-muted">
                        {new Date(run.scheduledFor).toLocaleString()}
                      </span>
                      {run.taskId && onOpenTask ? (
                        <button
                          type="button"
                          onClick={() => onOpenTask(run.taskId!)}
                          className="text-blue-600 hover:underline"
                        >
                          {t('workbench.project_automation_open_task')}
                        </button>
                      ) : null}
                      {run.status === 'waiting_device' || run.status === 'running' ? (
                        <button
                          type="button"
                          data-testid={`project-automation-cancel-run-${run.id}`}
                          disabled={busy}
                          onClick={() => void cancelRun(run.id)}
                          className="flex h-7 items-center gap-1 rounded-md px-2 text-text-muted hover:bg-surface"
                        >
                          <Pause className="h-3.5 w-3.5" />
                          {t('workbench.project_automation_cancel_run')}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </CloudTodoModal>
      ) : null}
    </section>
  )
}
