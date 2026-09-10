import type { ProjectAutomationInput } from '@/api/projectAutomations'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { DeviceInfo, Team, UnifiedModel } from '@/types/api'

export type ScheduleFrequency = 'daily' | 'weekdays' | 'weekly'

export interface VisualSchedule {
  frequency: ScheduleFrequency
  time: string
  weekday: string
}

export interface ProjectAutomationDraft {
  name: string
  prompt: string
  triggerType: 'schedule' | 'event'
  eventType: 'task.created' | null
  eventConfig: Record<string, unknown>
  assignmentMode: ProjectAutomationInput['assignmentMode']
  managerType: 'custom' | 'wegent' | null
  cronExpression: string | null
  timezone: string
  agentId: string | null
  wegentTeamId: number | null
  model: string | null
  executionEnvironment: 'local' | 'cloud' | null
  executionDeviceId: string | null
  roleSource: 'generic' | 'agent'
  runtimeSource: 'agent_default' | 'fixed_profile' | 'issue_creator' | 'runtime_user'
  runtimeProfileId: string | null
  runtimeUserId: number | null
  enabled: boolean
}

export type ProjectAutomationTemplate = Pick<ProjectAutomationDraft, 'name' | 'prompt'> &
  Partial<
    Pick<
      ProjectAutomationDraft,
      'triggerType' | 'eventType' | 'assignmentMode' | 'managerType' | 'agentId'
    >
  > & {
    schedule?: VisualSchedule
  }

export const DEFAULT_AI_MANAGED_PROMPT_KEY = 'workbench.project_automation_default_managed_prompt'

export const defaultSchedule = (): VisualSchedule => ({
  frequency: 'daily',
  time: '03:00',
  weekday: '1',
})

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

export const cronToSchedule = (cronExpression: string): VisualSchedule => {
  const [minute = '0', hour = '3', , , dayOfWeek = '*'] = cronExpression.trim().split(/\s+/)
  const time = `${String(validTimePart(hour, 3, 23)).padStart(2, '0')}:${String(
    validTimePart(minute, 0, 59)
  ).padStart(2, '0')}`
  if (dayOfWeek === '1-5') return { frequency: 'weekdays', time, weekday: '1' }
  if (/^[0-6]$/.test(dayOfWeek)) return { frequency: 'weekly', time, weekday: dayOfWeek }
  return { frequency: 'daily', time, weekday: '1' }
}

export const weekdayOptions = (t: (key: string) => string) => [
  { value: '1', label: t('workbench.project_automation_monday') },
  { value: '2', label: t('workbench.project_automation_tuesday') },
  { value: '3', label: t('workbench.project_automation_wednesday') },
  { value: '4', label: t('workbench.project_automation_thursday') },
  { value: '5', label: t('workbench.project_automation_friday') },
  { value: '6', label: t('workbench.project_automation_saturday') },
  { value: '0', label: t('workbench.project_automation_sunday') },
]

export const formatSchedule = (schedule: VisualSchedule, t: (key: string) => string): string => {
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

export const timezoneLabel = (timezone: string, t: (key: string) => string): string =>
  timezone === 'Asia/Shanghai' ? t('workbench.project_automation_timezone_shanghai') : timezone

export const formatTimestamp = (value: string, timezone: string): string => {
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

export const timezoneOptions = (current: string): string[] =>
  Array.from(
    new Set([current, 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC'])
  ).filter(Boolean)

export const executionEnvironmentForDevice = (
  device: DeviceInfo | undefined
): 'local' | 'cloud' | null => {
  if (device?.device_type === 'local' || device?.device_type === 'app') return 'local'
  if (device?.device_type === 'cloud' || device?.device_type === 'remote') return 'cloud'
  return null
}

export const modelSupportsEnvironment = (
  model: UnifiedModel,
  environment: 'local' | 'cloud'
): boolean =>
  model.isActive !== false &&
  !model.compatibilityDisabled &&
  (environment === 'local' || model.type !== 'runtime')

export const defaultCustomConfiguration = (
  models: UnifiedModel[],
  devices: DeviceInfo[]
): Pick<ProjectAutomationDraft, 'model' | 'executionEnvironment' | 'executionDeviceId'> => {
  const orderedDevices = [...devices].sort(
    (left, right) => Number(right.is_default) - Number(left.is_default)
  )
  for (const device of orderedDevices) {
    const environment = executionEnvironmentForDevice(device)
    if (!environment) continue
    const model = models.find(candidate => modelSupportsEnvironment(candidate, environment))
    if (model) {
      return {
        model: model.name,
        executionEnvironment: environment,
        executionDeviceId: device.device_id,
      }
    }
  }
  return { model: null, executionEnvironment: null, executionDeviceId: null }
}

export const customConfigurationIsSelectable = (
  draft: ProjectAutomationDraft,
  models: UnifiedModel[],
  devices: DeviceInfo[]
): boolean => {
  if (
    draft.assignmentMode !== 'ai_managed' ||
    draft.managerType !== 'custom' ||
    !draft.model ||
    !draft.executionEnvironment ||
    !draft.executionDeviceId
  ) {
    return false
  }
  const environment = draft.executionEnvironment
  const device = devices.find(candidate => candidate.device_id === draft.executionDeviceId)
  if (executionEnvironmentForDevice(device) !== environment) return false
  return models.some(
    model => model.name === draft.model && modelSupportsEnvironment(model, environment)
  )
}

export const projectRobotIsSelectable = (
  draft: ProjectAutomationDraft,
  agents: ProjectChatAgent[]
): boolean =>
  draft.assignmentMode === 'manual' &&
  Boolean(draft.agentId) &&
  agents.some(agent => agent.id === draft.agentId)

export const wegentManagerIsSelectable = (draft: ProjectAutomationDraft, teams: Team[]): boolean =>
  draft.assignmentMode === 'ai_managed' &&
  draft.managerType === 'wegent' &&
  draft.wegentTeamId != null &&
  teams.some(team => team.id === draft.wegentTeamId)

export const wegentTeamLabel = (team: Team, teams: Team[]): string => {
  const label = team.displayName || team.name
  const duplicates = teams.filter(candidate => (candidate.displayName || candidate.name) === label)
  if (duplicates.length < 2) return label
  return `${label} · ${team.namespace || 'default'}/${team.name}`
}

export const defaultInput = (defaultPrompt: string): ProjectAutomationDraft => ({
  name: '',
  prompt: defaultPrompt,
  triggerType: 'schedule',
  eventType: null,
  eventConfig: {},
  assignmentMode: 'manual',
  managerType: null,
  cronExpression: '0 3 * * *',
  timezone: 'Asia/Shanghai',
  agentId: null,
  wegentTeamId: null,
  model: null,
  executionEnvironment: null,
  executionDeviceId: null,
  roleSource: 'agent',
  runtimeSource: 'agent_default',
  runtimeProfileId: null,
  runtimeUserId: null,
  enabled: true,
})

export const draftFromTemplate = (
  template: ProjectAutomationTemplate | undefined,
  agents: ProjectChatAgent[],
  models: UnifiedModel[],
  devices: DeviceInfo[]
): { draft: ProjectAutomationDraft; schedule: VisualSchedule } => {
  const draft = defaultInput('')
  draft.agentId = agents[0]?.id ?? null
  if (template) {
    draft.name = template.name
    draft.prompt = template.prompt
    draft.triggerType = template.triggerType ?? draft.triggerType
    draft.eventType = template.eventType ?? draft.eventType
    draft.assignmentMode = template.assignmentMode ?? draft.assignmentMode
    draft.managerType = template.managerType ?? draft.managerType
    draft.agentId = draft.assignmentMode === 'manual' ? (template.agentId ?? draft.agentId) : null
  }
  if (draft.assignmentMode === 'ai_managed' && draft.managerType === 'custom') {
    Object.assign(draft, defaultCustomConfiguration(models, devices))
  }
  return { draft, schedule: template?.schedule ?? defaultSchedule() }
}

export const buildAutomationInput = (
  draft: ProjectAutomationDraft,
  schedule: VisualSchedule,
  eventConfig: Record<string, unknown>
): ProjectAutomationInput | null => {
  const common = {
    name: draft.name,
    prompt: draft.prompt,
    triggerType: draft.triggerType,
    eventType: draft.triggerType === 'event' ? ('task.created' as const) : null,
    eventConfig,
    cronExpression: draft.triggerType === 'schedule' ? scheduleToCron(schedule) : null,
    timezone: draft.timezone,
    enabled: draft.enabled,
    roleSource: draft.roleSource,
    runtimeSource: draft.runtimeSource,
    runtimeProfileId: draft.runtimeSource === 'fixed_profile' ? draft.runtimeProfileId : null,
    runtimeUserId: draft.runtimeSource === 'runtime_user' ? draft.runtimeUserId : null,
  }
  if (
    draft.assignmentMode === 'manual' &&
    (draft.roleSource === 'generic' || draft.agentId) &&
    (draft.runtimeSource !== 'fixed_profile' || draft.runtimeProfileId)
  ) {
    return {
      ...common,
      assignmentMode: 'manual',
      managerType: null,
      agentId: draft.roleSource === 'agent' ? draft.agentId : null,
      wegentTeamId: null,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
    }
  }
  if (
    draft.assignmentMode === 'ai_managed' &&
    draft.managerType === 'custom' &&
    draft.runtimeSource === 'fixed_profile' &&
    draft.runtimeProfileId
  ) {
    return {
      ...common,
      assignmentMode: 'ai_managed',
      managerType: 'custom',
      agentId: null,
      wegentTeamId: null,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
    }
  }
  if (
    draft.assignmentMode === 'ai_managed' &&
    draft.managerType === 'wegent' &&
    draft.wegentTeamId != null
  ) {
    return {
      ...common,
      assignmentMode: 'ai_managed',
      managerType: 'wegent',
      agentId: null,
      wegentTeamId: draft.wegentTeamId,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
    }
  }
  return null
}
