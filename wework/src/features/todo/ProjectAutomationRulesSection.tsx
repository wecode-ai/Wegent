import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  CheckCircle2,
  CircleX,
  Clock3,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react'
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
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import type { DeviceInfo } from '@/types/api'
import type { Team, UnifiedModel } from '@/types/api'
import { CloudTodoModal } from './CloudTodoModal'
import { executionDisplayStatus, isExecutionFailed, isExecutionRunning } from './executionStatus'
import { ProjectAutomationTemplates } from './ProjectAutomationTemplates'
import { ProjectAutomationRunDetailDialog } from './ProjectAutomationRunDetailDialog'
import {
  DEFAULT_AI_MANAGED_PROMPT_KEY,
  buildAutomationInput,
  cronToSchedule,
  customConfigurationIsSelectable,
  defaultCustomConfiguration,
  defaultSchedule,
  draftFromTemplate,
  executionEnvironmentForDevice,
  formatSchedule,
  formatTimestamp,
  modelSupportsEnvironment,
  projectRobotIsSelectable,
  timezoneLabel,
  timezoneOptions,
  wegentManagerIsSelectable,
  wegentTeamLabel,
  weekdayOptions,
  type ProjectAutomationDraft,
  type ProjectAutomationTemplate,
  type ScheduleFrequency,
  type VisualSchedule,
} from './projectAutomationForm'

type AutomationApi = ReturnType<typeof createProjectAutomationApi>
type AgentApi = ReturnType<typeof createProjectChatAgentApi>

export function ProjectAutomationRulesSection({
  projectId,
  api,
  agentApi,
  canManage,
  deviceApi,
  modelApi,
  teamApi,
  onOpenTask,
  projectTags = [],
}: {
  projectId: string
  api?: AutomationApi
  agentApi?: AgentApi
  canManage: boolean
  deviceApi?: { listDevices: () => Promise<DeviceInfo[]> }
  modelApi?: { listModels: () => Promise<{ data: UnifiedModel[] }> }
  teamApi?: { listTeams: () => Promise<Team[]> }
  onOpenTask?: (taskId: string) => void
  projectTags?: string[]
}) {
  const { t } = useTranslation('common')
  const backendUrl = getRuntimeConfig().wegentBackendUrl || window.location.origin
  const [rules, setRules] = useState<ProjectAutomationRule[]>([])
  const [agents, setAgents] = useState<ProjectChatAgent[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [models, setModels] = useState<UnifiedModel[]>([])
  const [wegentTeams, setWegentTeams] = useState<Team[]>([])
  const [runs, setRuns] = useState<ProjectAutomationRun[]>([])
  const [detailRun, setDetailRun] = useState<ProjectAutomationRun | null>(null)
  const [selected, setSelected] = useState<ProjectAutomationRule | null>(null)
  const [draft, setDraft] = useState<ProjectAutomationDraft | null>(null)
  const [schedule, setSchedule] = useState<VisualSchedule>(defaultSchedule)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [createdWebhook, setCreatedWebhook] = useState<{
    eventId: string
    secret: string
  } | null>(null)

  const load = useCallback(async () => {
    if (!api || !agentApi) return
    const [ruleResult, agentResult, deviceResult, modelResult, teamResult] =
      await Promise.allSettled([
        api.list(projectId),
        agentApi.list(projectId),
        deviceApi?.listDevices() ?? Promise.resolve([]),
        modelApi?.listModels().then(response => response.data) ?? Promise.resolve([]),
        teamApi?.listTeams() ?? Promise.resolve([]),
      ])
    if (ruleResult.status === 'fulfilled') {
      setRules(ruleResult.value)
      setSelected(current =>
        current ? (ruleResult.value.find(rule => rule.id === current.id) ?? null) : null
      )
    }
    if (agentResult.status === 'fulfilled') {
      setAgents(agentResult.value.filter(agent => agent.status === 'active'))
    }
    if (deviceResult.status === 'fulfilled') setDevices(deviceResult.value)
    if (modelResult.status === 'fulfilled') setModels(modelResult.value)
    if (teamResult.status === 'fulfilled') {
      setWegentTeams(teamResult.value.filter(team => team.is_active !== false))
    }
    const failure = [ruleResult, agentResult, deviceResult, modelResult, teamResult].find(
      result => result.status === 'rejected'
    )
    if (failure?.status === 'rejected') {
      setError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason))
    } else {
      setError('')
    }
  }, [agentApi, api, deviceApi, modelApi, projectId, teamApi])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    const ruleId = selected?.id
    if (!api || !ruleId || !runs.some(run => isExecutionRunning(run.status))) return

    let disposed = false
    const timer = window.setTimeout(() => {
      void api
        .listRuns(projectId, ruleId)
        .then(latestRuns => {
          if (disposed) return
          setRuns(latestRuns)
          if (!latestRuns.some(run => isExecutionRunning(run.status))) void load()
        })
        .catch(loadError => {
          if (!disposed) {
            setError(loadError instanceof Error ? loadError.message : String(loadError))
          }
        })
    }, 1000)

    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [api, load, projectId, runs, selected?.id])

  const selectRule = async (rule: ProjectAutomationRule) => {
    setSelected(rule)
    setDraft({
      name: rule.name,
      prompt: rule.prompt,
      triggerType: rule.triggerType,
      eventType: rule.eventType,
      eventConfig: rule.eventConfig,
      assignmentMode: rule.assignmentMode,
      managerType: rule.managerType,
      cronExpression: rule.cronExpression,
      timezone: rule.timezone,
      agentId: rule.assignmentMode === 'manual' ? rule.agentId : null,
      wegentTeamId: rule.managerType === 'wegent' ? rule.wegentTeamId : null,
      model: rule.managerType === 'custom' ? rule.model : null,
      executionEnvironment: rule.managerType === 'custom' ? rule.executionEnvironment : null,
      executionDeviceId: rule.managerType === 'custom' ? rule.executionDeviceId : null,
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

  const createRule = (template?: ProjectAutomationTemplate) => {
    const next = draftFromTemplate(template, agents, models, devices)
    setSelected(null)
    setRuns([])
    setCreatedWebhook(null)
    setDraft(next.draft)
    setSchedule(next.schedule)
  }

  const save = async () => {
    if (!api || !draft) return
    if (
      !draft.name.trim() ||
      !draft.prompt.trim() ||
      (draft.assignmentMode === 'manual' && !projectRobotIsSelectable(draft, agents)) ||
      (draft.assignmentMode === 'ai_managed' &&
        draft.managerType === 'custom' &&
        !customConfigurationIsSelectable(draft, models, devices)) ||
      (draft.assignmentMode === 'ai_managed' &&
        draft.managerType === 'wegent' &&
        !wegentManagerIsSelectable(draft, wegentTeams))
    ) {
      setError(t('workbench.project_automation_required_fields'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const eventConfig =
        draft.triggerType === 'event' ? { tags: conditionValues('tags') } : draft.eventConfig
      const input = buildAutomationInput(draft, schedule, eventConfig)
      if (!input) {
        setError(t('workbench.project_automation_required_fields'))
        return
      }
      if (selected) {
        await api.update(projectId, selected.id, { ...input, version: selected.version })
      } else {
        const created = await api.create(projectId, input)
        setCreatedWebhook(
          created.webhookEventId && created.webhookSecret
            ? { eventId: created.webhookEventId, secret: created.webhookSecret }
            : null
        )
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

  const rotateWebhookSecret = async (rule: ProjectAutomationRule) => {
    if (!api || !window.confirm(t('workbench.project_automation_rotate_secret_confirm'))) return
    setBusy(true)
    setError('')
    try {
      const updated = await api.rotateWebhookSecret(projectId, rule.id)
      if (updated.webhookEventId && updated.webhookSecret) {
        setCreatedWebhook({ eventId: updated.webhookEventId, secret: updated.webhookSecret })
      }
      await load()
    } catch (rotateError) {
      setError(rotateError instanceof Error ? rotateError.message : String(rotateError))
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

  const retryRun = async (runId: string) => {
    if (!api || !selected) return
    setBusy(true)
    setError('')
    try {
      await api.retryRun(projectId, runId)
      setRuns(await api.listRuns(projectId, selected.id))
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = useMemo(
    () => ({
      queued: t('workbench.project_automation_queued'),
      running: t('workbench.project_automation_running'),
      completed: t('workbench.project_automation_completed'),
    }),
    [t]
  )

  if (!api || !agentApi) return null

  const conditionValues = (key: 'tags'): string[] => {
    const value = draft?.eventConfig[key]
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  }
  const toggleCondition = (key: 'tags', value: string) => {
    if (!draft) return
    const current = conditionValues(key)
    const next = current.includes(value)
      ? current.filter(candidate => candidate !== value)
      : [...current, value]
    setDraft({ ...draft, eventConfig: { ...draft.eventConfig, [key]: next } })
  }
  const conditionButton = (key: 'tags', value: string, label: string) => {
    const selected = conditionValues(key).includes(value)
    return (
      <button
        key={value}
        type="button"
        data-testid={`project-automation-condition-${key}-${value}`}
        onClick={() => toggleCondition(key, value)}
        className={`rounded-full px-3 py-1 text-xs transition ${
          selected ? 'bg-text-primary text-background' : 'bg-surface text-text-secondary'
        }`}
      >
        {label}
      </button>
    )
  }

  return (
    <section data-testid="project-automation-rules" className="mt-8">
      <div className={`flex items-center justify-between gap-3${rules.length ? ' mb-3' : ''}`}>
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
            onClick={() => createRule()}
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
              className="overflow-hidden rounded-xl border border-border transition hover:border-text-tertiary"
            >
              <div className="flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left hover:bg-surface">
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
                  {rule.lastRunStatus
                    ? rule.lastRunStatus === 'queued'
                      ? statusLabel.queued
                      : statusLabel[executionDisplayStatus(rule.lastRunStatus) ?? 'running']
                    : rule.triggerType === 'event' && rule.enabled
                      ? t('workbench.project_automation_waiting_event')
                      : rule.nextRunAt
                        ? `${formatTimestamp(rule.nextRunAt, rule.timezone)} · ${timezoneLabel(rule.timezone, t)}`
                        : t('workbench.project_automation_disabled')}
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
              {createdWebhook?.eventId === rule.webhookEventId ? (
                <div className="border-t border-border bg-surface px-4 py-3">
                  <p className="text-xs text-text-muted">
                    {t('workbench.project_automation_webhook_event_id')}
                  </p>
                  <code className="mt-1 block break-all text-code text-text-primary">
                    {backendUrl}/api/v1/cloud-projects/automation-events/{createdWebhook.eventId}
                  </code>
                  <p className="mt-3 text-xs text-text-muted">
                    {t('workbench.project_automation_webhook_secret')}
                  </p>
                  <code className="mt-1 block break-all text-code text-text-primary">
                    {createdWebhook.secret}
                  </code>
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <ProjectAutomationTemplates canManage={canManage} onSelect={createRule} t={t} />
        )}
      </div>

      {draft ? (
        <CloudTodoModal
          title={
            selected
              ? t('workbench.project_automation_edit')
              : t('workbench.project_automation_new')
          }
          width="workspace"
          onClose={() => {
            setDraft(null)
            setSelected(null)
          }}
        >
          <div
            className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto border-t border-border md:grid-cols-[minmax(0,1.65fr)_minmax(360px,1fr)] md:overflow-hidden"
            data-testid="project-automation-editor"
          >
            <div className="flex min-h-[520px] flex-col px-7 py-6 md:min-h-0">
              <input
                data-testid="project-automation-name"
                value={draft.name}
                autoFocus={!selected}
                onChange={event => setDraft({ ...draft, name: event.target.value })}
                placeholder={t('workbench.project_automation_name')}
                className="w-full border-0 bg-transparent p-0 text-heading-lg font-semibold tracking-[-0.03em] text-text-primary outline-none placeholder:text-text-tertiary"
              />
              <label
                htmlFor="project-automation-prompt-field"
                className="mt-6 text-xs font-semibold uppercase tracking-wider text-text-muted"
              >
                {t('workbench.project_automation_prompt')}
              </label>
              <textarea
                id="project-automation-prompt-field"
                data-testid="project-automation-prompt"
                value={draft.prompt}
                onChange={event => setDraft({ ...draft, prompt: event.target.value })}
                placeholder={t('workbench.project_automation_prompt')}
                className="mt-2 min-h-72 flex-1 resize-none rounded-2xl border border-border bg-background px-5 py-4 text-sm leading-6 text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-text-tertiary"
              />
            </div>

            <div className="min-h-0 border-t border-border px-6 pb-6 pt-1 md:overflow-y-auto md:border-l md:border-t-0">
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
                      {
                        value: 'schedule',
                        label: t('workbench.project_automation_scheduled_trigger'),
                      },
                      {
                        value: 'event',
                        label: t('workbench.project_automation_task_created_trigger'),
                      },
                    ]}
                  />
                </SettingsRow>
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
                    {backendUrl}/api/v1/cloud-projects/automation-events/{selected.webhookEventId}
                  </code>
                  {createdWebhook?.eventId === selected.webhookEventId ? (
                    <>
                      <p className="mt-3 text-xs text-text-muted">
                        {t('workbench.project_automation_webhook_secret')}
                      </p>
                      <code className="mt-1 block break-all text-code text-text-primary">
                        {createdWebhook.secret}
                      </code>
                    </>
                  ) : null}
                  <button
                    type="button"
                    data-testid="project-automation-rotate-webhook-secret"
                    disabled={busy || !canManage}
                    onClick={() => void rotateWebhookSecret(selected)}
                    className="mt-3 flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-background disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('workbench.project_automation_rotate_secret')}
                  </button>
                </div>
              ) : null}

              {draft.triggerType === 'event' && projectTags.length ? (
                <>
                  <SectionTitle title={t('workbench.project_automation_conditions')} />
                  <SettingsGroup>
                    <SettingsRow label={t('workbench.project_automation_condition_tags')}>
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {projectTags.map(tag => conditionButton('tags', tag, tag))}
                      </div>
                    </SettingsRow>
                  </SettingsGroup>
                  <p className="mt-2 px-1 text-xs text-text-muted">
                    {t('workbench.project_automation_tags_hint')}
                  </p>
                </>
              ) : null}

              <div className="mt-7">
                <SettingsGroup>
                  <SettingsRow label={t('workbench.project_automation_execution_mode')}>
                    <MenuSelect
                      testId="project-automation-executor-type"
                      value={draft.assignmentMode}
                      pill
                      onChange={value => {
                        const assignmentMode = value as ProjectAutomationInput['assignmentMode']
                        const customConfiguration = customConfigurationIsSelectable(
                          {
                            ...draft,
                            assignmentMode: 'ai_managed',
                            managerType: 'custom',
                          },
                          models,
                          devices
                        )
                          ? {
                              model: draft.model,
                              executionEnvironment: draft.executionEnvironment,
                              executionDeviceId: draft.executionDeviceId,
                            }
                          : defaultCustomConfiguration(models, devices)
                        setDraft({
                          ...draft,
                          assignmentMode,
                          prompt:
                            assignmentMode === 'ai_managed' && !draft.prompt.trim()
                              ? t(DEFAULT_AI_MANAGED_PROMPT_KEY)
                              : draft.prompt,
                          managerType:
                            assignmentMode === 'ai_managed'
                              ? (draft.managerType ?? 'custom')
                              : null,
                          agentId:
                            assignmentMode === 'manual'
                              ? (draft.agentId ?? agents[0]?.id ?? null)
                              : draft.agentId,
                          ...(assignmentMode === 'ai_managed' ? customConfiguration : {}),
                        })
                      }}
                      options={[
                        {
                          value: 'manual',
                          label: t('workbench.project_automation_manual_assignment'),
                        },
                        {
                          value: 'ai_managed',
                          label: t('workbench.project_automation_ai_managed'),
                        },
                      ]}
                    />
                  </SettingsRow>
                  {draft.assignmentMode === 'manual' ? (
                    <SettingsRow label={t('workbench.project_automation_robot')}>
                      <MenuSelect
                        testId="project-automation-agent"
                        value={draft.agentId ?? ''}
                        pill
                        onChange={value => setDraft({ ...draft, agentId: value || null })}
                        options={[
                          { value: '', label: t('workbench.project_automation_select_robot') },
                          ...agents.map(agent => ({ value: agent.id, label: agent.name })),
                        ]}
                      />
                    </SettingsRow>
                  ) : null}
                  {draft.assignmentMode === 'ai_managed' ? (
                    <SettingsRow label={t('workbench.project_automation_manager_source')}>
                      <MenuSelect
                        testId="project-automation-manager-type"
                        value={draft.managerType ?? 'custom'}
                        pill
                        onChange={value =>
                          setDraft({
                            ...draft,
                            managerType: value as 'custom' | 'wegent',
                          })
                        }
                        options={[
                          {
                            value: 'custom',
                            label: t('workbench.project_automation_custom_ai'),
                          },
                          {
                            value: 'wegent',
                            label: t('workbench.project_automation_wegent_manager'),
                          },
                        ]}
                      />
                    </SettingsRow>
                  ) : null}
                  {draft.assignmentMode === 'ai_managed' && draft.managerType === 'custom' ? (
                    <>
                      <SettingsRow label={t('workbench.project_automation_model')}>
                        <MenuSelect
                          testId="project-automation-model"
                          value={draft.model ?? ''}
                          pill
                          onChange={value => setDraft({ ...draft, model: value || null })}
                          options={[
                            { value: '', label: t('workbench.project_automation_select_model') },
                            ...models
                              .filter(
                                model =>
                                  model.isActive !== false &&
                                  !model.compatibilityDisabled &&
                                  (!draft.executionEnvironment ||
                                    modelSupportsEnvironment(model, draft.executionEnvironment))
                              )
                              .map(model => ({
                                value: model.name,
                                label: model.displayName || model.name,
                              })),
                          ]}
                        />
                      </SettingsRow>
                      <SettingsRow label={t('workbench.project_automation_device')}>
                        <MenuSelect
                          testId="project-automation-device"
                          value={draft.executionDeviceId ?? ''}
                          pill
                          onChange={value => {
                            const device = devices.find(candidate => candidate.device_id === value)
                            const environment = executionEnvironmentForDevice(device)
                            const currentModel = environment
                              ? models.find(
                                  candidate =>
                                    candidate.name === draft.model &&
                                    modelSupportsEnvironment(candidate, environment)
                                )
                              : null
                            setDraft({
                              ...draft,
                              executionDeviceId: value || null,
                              executionEnvironment: environment,
                              model: environment
                                ? (currentModel?.name ??
                                  models.find(candidate =>
                                    modelSupportsEnvironment(candidate, environment)
                                  )?.name ??
                                  null)
                                : null,
                            })
                          }}
                          options={[
                            { value: '', label: t('workbench.project_automation_select_device') },
                            ...devices.flatMap(device =>
                              executionEnvironmentForDevice(device)
                                ? [
                                    {
                                      value: device.device_id,
                                      label: device.name || device.device_id,
                                    },
                                  ]
                                : []
                            ),
                          ]}
                        />
                      </SettingsRow>
                    </>
                  ) : null}
                  {draft.assignmentMode === 'ai_managed' && draft.managerType === 'wegent' ? (
                    <SettingsRow label={t('workbench.project_automation_wegent_manager')}>
                      <MenuSelect
                        testId="project-automation-wegent-robot"
                        value={draft.wegentTeamId == null ? '' : String(draft.wegentTeamId)}
                        pill
                        onChange={value =>
                          setDraft({
                            ...draft,
                            wegentTeamId: value ? Number(value) : null,
                          })
                        }
                        options={[
                          {
                            value: '',
                            label: t('workbench.project_automation_select_wegent_manager'),
                          },
                          ...wegentTeams.map(team => ({
                            value: String(team.id),
                            label: wegentTeamLabel(team, wegentTeams),
                          })),
                        ]}
                      />
                    </SettingsRow>
                  ) : null}
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
                  <div
                    className="max-h-80 divide-y divide-border overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border border-border px-4"
                    data-testid="project-automation-run-list"
                  >
                    {runs.map(run => {
                      const finished = !isExecutionRunning(run.status)
                      const failed = isExecutionFailed(run.status) || Boolean(run.error)
                      return (
                        <div key={run.id} className="flex min-h-10 items-center gap-3 py-2 text-sm">
                          {finished ? (
                            <button
                              type="button"
                              data-testid={`project-automation-run-detail-${run.id}`}
                              aria-label={t(
                                failed
                                  ? 'workbench.project_automation_run_failed_details'
                                  : 'workbench.project_automation_run_succeeded_details'
                              )}
                              title={t(
                                failed
                                  ? 'workbench.project_automation_run_failed_details'
                                  : 'workbench.project_automation_run_succeeded_details'
                              )}
                              onClick={() => setDetailRun(run)}
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-surface ${failed ? 'text-red-600' : 'text-green-600'}`}
                            >
                              {failed ? (
                                <CircleX className="h-4 w-4" aria-hidden="true" />
                              ) : (
                                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                              )}
                            </button>
                          ) : (
                            <span className="w-8 shrink-0">
                              {run.status === 'queued'
                                ? statusLabel.queued
                                : statusLabel[executionDisplayStatus(run.status) ?? 'running']}
                            </span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span
                              className="block truncate text-text-secondary"
                              data-testid={`project-automation-run-task-${run.id}`}
                            >
                              {run.taskTitle || run.taskId || t('workbench.project_automation_run')}
                            </span>
                            <span className="block truncate text-xs text-text-muted">
                              {formatTimestamp(run.scheduledFor, run.timezone)} ·{' '}
                              {timezoneLabel(run.timezone, t)}
                            </span>
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
                          {(run.retryable ?? failed) ? (
                            <button
                              type="button"
                              data-testid={`project-automation-retry-run-${run.id}`}
                              disabled={busy}
                              onClick={() => void retryRun(run.id)}
                              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-text-muted hover:bg-surface disabled:opacity-40"
                            >
                              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                              {t('workbench.project_automation_retry_run')}
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
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-6 py-3">
            <div className="flex items-center gap-1">
              {selected ? (
                <>
                  {selected.triggerType === 'schedule' ? (
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
                  ) : null}
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
              disabled={
                busy ||
                !draft.name.trim() ||
                !draft.prompt.trim() ||
                (draft.assignmentMode === 'manual' && !projectRobotIsSelectable(draft, agents)) ||
                (draft.assignmentMode === 'ai_managed' &&
                  draft.managerType === 'custom' &&
                  !customConfigurationIsSelectable(draft, models, devices)) ||
                (draft.assignmentMode === 'ai_managed' &&
                  draft.managerType === 'wegent' &&
                  !wegentManagerIsSelectable(draft, wegentTeams))
              }
              onClick={() => void save()}
              className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background disabled:opacity-50"
            >
              {t('workbench.save')}
            </button>
          </footer>
          {detailRun ? (
            <ProjectAutomationRunDetailDialog
              run={detailRun}
              onClose={() => setDetailRun(null)}
              t={t}
            />
          ) : null}
        </CloudTodoModal>
      ) : null}
    </section>
  )
}
