import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Clock3, Loader2, Pause, Play, Plus, Trash2 } from 'lucide-react'
import type {
  ProjectAutomationInput,
  ProjectAutomationRule,
  ProjectAutomationRun,
  createProjectAutomationApi,
} from '@/api/projectAutomations'
import type { ProjectChatAgent, createProjectChatAgentApi } from '@/api/projectChatAgents'
import { MenuSelect } from '@/components/common/MenuSelect'
import { SectionTitle, SettingsGroup, SettingsRow } from '@/components/common/SettingsGroup'
import { SettingsSwitch } from '@/components/settings/settings-ui'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import { CloudTodoModal } from './CloudTodoModal'
import { executionDisplayStatus, isExecutionFailed, isExecutionRunning } from './executionStatus'

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

const timezoneLabel = (timezone: string, t: (key: string) => string): string =>
  timezone === 'Asia/Shanghai' ? t('workbench.project_automation_timezone_shanghai') : timezone

const formatTimestamp = (value: string, timezone: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find(candidate => candidate.type === type)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
  } catch {
    return value
  }
}

const timezoneOptions = (current: string): string[] =>
  Array.from(
    new Set([current, 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC'])
  ).filter(Boolean)

const defaultInput = (): ProjectAutomationInput => ({
  name: '',
  prompt: '',
  triggerType: 'schedule',
  eventType: null,
  eventConfig: {},
  cronExpression: '0 3 * * *',
  timezone: 'Asia/Shanghai',
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
      triggerType: rule.triggerType,
      eventType: rule.eventType,
      eventConfig: rule.eventConfig,
      cronExpression: rule.cronExpression,
      timezone: rule.timezone,
      agentId: rule.agentId,
      enabled: rule.enabled,
    })
    setSchedule(cronToSchedule(rule.cronExpression ?? '0 3 * * *'))
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
      const input: ProjectAutomationInput = {
        ...draft,
        cronExpression: draft.triggerType === 'schedule' ? scheduleToCron(schedule) : null,
        eventType: draft.triggerType === 'event' ? 'task.created' : null,
      }
      if (selected) {
        await api.update(projectId, selected.id, { ...input, version: selected.version })
      } else {
        await api.create(projectId, input)
      }
      setSelected(null)
      setDraft(null)
      setRuns([])
      await load()
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

  const toggleRuleEnabled = async (rule: ProjectAutomationRule, enabled: boolean) => {
    if (!api) return
    setBusy(true)
    setError('')
    try {
      await api.update(projectId, rule.id, {
        name: rule.name,
        prompt: rule.prompt,
        triggerType: rule.triggerType,
        eventType: rule.eventType,
        eventConfig: rule.eventConfig,
        cronExpression: rule.cronExpression,
        timezone: rule.timezone,
        agentId: rule.agentId,
        enabled,
        version: rule.version,
      })
      await load()
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
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
      running: t('workbench.project_automation_running'),
      completed: t('workbench.project_automation_completed'),
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

      {error && !draft ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}
      <div className="space-y-2" data-testid="project-automation-rule-list">
        {rules.length ? (
          rules.map(rule => (
            <div
              key={rule.id}
              role="button"
              tabIndex={0}
              data-testid={`project-automation-rule-${rule.id}`}
              onClick={() => void selectRule(rule)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void selectRule(rule)
                }
              }}
              className="flex w-full cursor-pointer items-center gap-4 rounded-xl border border-border px-4 py-3 text-left transition hover:border-text-tertiary hover:bg-surface"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <CalendarClock className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{rule.name}</span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {rule.triggerType === 'event'
                    ? t('workbench.project_automation_task_created')
                    : `${formatSchedule(cronToSchedule(rule.cronExpression ?? '0 3 * * *'), t)} · ${timezoneLabel(rule.timezone, t)}`}{' '}
                  · {rule.agentName}
                </span>
              </span>
              <span className="shrink-0 text-right text-xs text-text-muted">
                <span className="block">
                  {rule.lastRunStatus
                    ? statusLabel[executionDisplayStatus(rule.lastRunStatus) ?? 'running']
                    : rule.nextRunAt
                      ? `${formatTimestamp(rule.nextRunAt, rule.timezone)} · ${timezoneLabel(
                          rule.timezone,
                          t
                        )}`
                      : t('workbench.project_automation_disabled')}
                </span>
              </span>
              <span
                className="shrink-0"
                onClick={event => event.stopPropagation()}
                onKeyDown={event => event.stopPropagation()}
              >
                <SettingsSwitch
                  data-testid={`project-automation-toggle-${rule.id}`}
                  checked={rule.enabled}
                  disabled={busy || !canManage}
                  onCheckedChange={enabled => void toggleRuleEnabled(rule, enabled)}
                  aria-label={
                    rule.enabled
                      ? t('workbench.project_automation_enabled')
                      : t('workbench.project_automation_disabled')
                  }
                />
              </span>
            </div>
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
          <div
            className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4"
            data-testid="project-automation-editor"
          >
            <input
              data-testid="project-automation-name"
              value={draft.name}
              autoFocus={!selected}
              onChange={event => setDraft({ ...draft, name: event.target.value })}
              placeholder={t('workbench.project_automation_name')}
              className="w-full border-0 bg-transparent p-0 text-heading-md font-medium tracking-[-0.02em] text-text-primary outline-none placeholder:text-text-tertiary"
            />
            <textarea
              data-testid="project-automation-prompt"
              value={draft.prompt}
              onChange={event => setDraft({ ...draft, prompt: event.target.value })}
              placeholder={t('workbench.project_automation_prompt')}
              className="mt-3 min-h-24 w-full resize-y rounded-2xl border border-border bg-background px-4 py-3 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary"
            />

            <SectionTitle title={t('workbench.project_automation_trigger')} />
            <SettingsGroup>
              <SettingsRow label={t('workbench.project_automation_trigger')}>
                <MenuSelect
                  testId="project-automation-trigger-type"
                  value={draft.triggerType}
                  pill
                  onChange={value =>
                    setDraft({
                      ...draft,
                      triggerType: value as 'schedule' | 'event',
                      eventType: value === 'event' ? 'task.created' : null,
                    })
                  }
                  options={[
                    { value: 'schedule', label: t('workbench.project_automation_time_trigger') },
                    { value: 'event', label: t('workbench.project_automation_event_trigger') },
                  ]}
                />
              </SettingsRow>
              {draft.triggerType === 'event' ? (
                <SettingsRow label={t('workbench.project_automation_event')}>
                  <span className="text-sm font-medium">
                    {t('workbench.project_automation_task_created')}
                  </span>
                </SettingsRow>
              ) : null}
            </SettingsGroup>

            {draft.triggerType === 'schedule' ? (
              <>
                <SectionTitle
                  title={t('workbench.project_automation_schedule')}
                  action={<Clock3 className="h-4 w-4" />}
                />
                <SettingsGroup>
                  <SettingsRow label={t('workbench.project_automation_frequency')}>
                    <MenuSelect
                      testId="project-automation-frequency"
                      value={schedule.frequency}
                      pill
                      onChange={value =>
                        setSchedule({ ...schedule, frequency: value as ScheduleFrequency })
                      }
                      options={[
                        { value: 'daily', label: t('workbench.project_automation_daily') },
                        { value: 'weekdays', label: t('workbench.project_automation_weekdays') },
                        { value: 'weekly', label: t('workbench.project_automation_weekly') },
                      ]}
                    />
                  </SettingsRow>
                  {schedule.frequency === 'weekly' ? (
                    <SettingsRow label={t('workbench.project_automation_weekday')}>
                      <MenuSelect
                        testId="project-automation-weekday"
                        value={schedule.weekday}
                        pill
                        onChange={value => setSchedule({ ...schedule, weekday: value })}
                        options={weekdayOptions(t)}
                      />
                    </SettingsRow>
                  ) : null}
                  <SettingsRow label={t('workbench.project_automation_time')}>
                    <input
                      type="time"
                      step={60}
                      value={schedule.time}
                      onChange={event => setSchedule({ ...schedule, time: event.target.value })}
                      data-testid="project-automation-time"
                      aria-label={t('workbench.project_automation_time')}
                      className="h-8 rounded-full border-0 bg-surface px-2 text-sm font-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                    />
                  </SettingsRow>
                  <SettingsRow label={t('workbench.project_automation_timezone')}>
                    <MenuSelect
                      testId="project-automation-timezone"
                      value={draft.timezone}
                      pill
                      onChange={value => setDraft({ ...draft, timezone: value })}
                      options={timezoneOptions(draft.timezone).map(timezone => ({
                        value: timezone,
                        label:
                          timezone === 'Asia/Shanghai'
                            ? `${timezone} · ${timezoneLabel(timezone, t)}`
                            : timezone,
                      }))}
                    />
                  </SettingsRow>
                </SettingsGroup>
              </>
            ) : selected?.webhookEventId ? (
              <div className="mt-5 rounded-xl border border-border bg-surface px-4 py-3">
                <p className="text-xs text-text-muted">
                  {t('workbench.project_automation_webhook_event_id')}
                </p>
                <code className="mt-1 block break-all text-code text-text-primary">
                  /api/v1/cloud-projects/automation-events/{selected.webhookEventId}
                </code>
              </div>
            ) : null}

            <div className="mt-7">
              <SettingsGroup>
                <SettingsRow label={t('workbench.project_automation_robot')}>
                  <MenuSelect
                    testId="project-automation-agent"
                    value={draft.agentId}
                    pill
                    onChange={value => setDraft({ ...draft, agentId: value })}
                    options={[
                      { value: '', label: t('workbench.project_automation_select_robot') },
                      ...agents.map(agent => ({
                        value: agent.id,
                        label: `${agent.name} · ${agent.executionEnvironment}${
                          agent.executionEnvironment === 'local'
                            ? ` · ${
                                devices.find(device => device.device_id === agent.executionDeviceId)
                                  ?.status ?? 'offline'
                              }`
                            : ''
                        }`,
                      })),
                    ]}
                  />
                </SettingsRow>
              </SettingsGroup>
            </div>

            {error ? (
              <p className="mt-4 text-sm text-red-600" data-testid="project-automation-error">
                {error}
              </p>
            ) : null}

            {selected && runs.length ? (
              <div className="mt-7" data-testid="project-automation-runs">
                <h3 className="mb-2 px-1 text-sm font-medium text-text-tertiary">
                  {t('workbench.project_automation_runs')}
                </h3>
                <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border px-4">
                  {runs.slice(0, 5).map(run => (
                    <div key={run.id} className="flex min-h-10 items-center gap-3 py-2 text-sm">
                      <span className="w-16 shrink-0">
                        {statusLabel[executionDisplayStatus(run.status) ?? 'running']}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text-muted">
                        {formatTimestamp(run.scheduledFor, run.timezone)} ·{' '}
                        {timezoneLabel(run.timezone, t)}
                        {run.error ? (
                          <span
                            className={
                              isExecutionFailed(run.status)
                                ? 'block truncate text-red-600'
                                : 'block truncate text-text-muted'
                            }
                            title={run.error}
                            data-testid={`project-automation-run-error-${run.id}`}
                          >
                            {run.error}
                          </span>
                        ) : null}
                      </span>
                      {run.taskId && onOpenTask ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(null)
                            setDraft(null)
                            setRuns([])
                            onOpenTask(run.taskId!)
                          }}
                          className="shrink-0 text-blue-600 hover:underline"
                        >
                          {t('workbench.project_automation_open_task')}
                        </button>
                      ) : null}
                      {isExecutionRunning(run.status) ? (
                        <button
                          type="button"
                          data-testid={`project-automation-cancel-run-${run.id}`}
                          disabled={busy}
                          onClick={() => void cancelRun(run.id)}
                          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-text-muted hover:bg-surface"
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

          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-6 py-3">
            <div className="flex items-center gap-1">
              {selected ? (
                <>
                  <button
                    type="button"
                    data-testid="project-automation-run-now"
                    disabled={busy}
                    onClick={() => void runNow(selected)}
                    className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm hover:bg-surface disabled:opacity-50"
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
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-red-600 hover:bg-red-500/5"
                    aria-label={t('workbench.delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              ) : null}
            </div>
            <button
              type="button"
              data-testid="project-automation-save"
              disabled={busy || !draft.name.trim() || !draft.prompt.trim() || !draft.agentId}
              onClick={() => void save()}
              className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-50"
            >
              {t('workbench.save')}
            </button>
          </footer>
        </CloudTodoModal>
      ) : null}
    </section>
  )
}
