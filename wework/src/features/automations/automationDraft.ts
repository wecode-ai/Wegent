import { normalizeRuntimeWorkspacePath, runtimeProjectWorkKey } from '@/lib/runtime-project'
import type {
  ModelOptions,
  RuntimeGoalCreateInput,
  RuntimeProjectWork,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'
import type {
  Automation,
  AutomationConversationMode,
  AutomationNotificationPolicy,
  AutomationSchedule,
  AutomationSource,
} from '@/types/automation'

export type ScheduleType = AutomationSchedule['type']
export type CronPreset = 'weekdays' | 'daily' | 'weekly' | 'custom'
export type CustomFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface AutomationDraft {
  name: string
  prompt: string
  source: AutomationSource
  scheduleType: ScheduleType
  cronPreset: CronPreset
  cronExpression: string
  cronTime: string
  weeklyDay: string
  customFrequency: CustomFrequency
  customInterval: string
  customWeekdays: string[]
  intervalValue: string
  intervalUnit: 'minutes' | 'hours' | 'days'
  executeAt: string
  timezone: string
  deviceId: string
  workspacePath: string
  conversationMode: AutomationConversationMode
  continuationAddress: RuntimeTaskAddress | null
  goalEnabled: boolean
  notificationPolicy: AutomationNotificationPolicy
  modelId: string
  modelType: string
  modelOptions: ModelOptions
}

export interface AutomationProjectOption {
  key: string
  name: string
  workspacePath: string
  workspaceKind: RuntimeProjectWork['deviceWorkspaces'][number]['workspaceKind']
  workspaceLabel: string | null
}

export interface AutomationTaskOption {
  key: string
  label: string
  address: RuntimeTaskAddress
}

export function buildAutomationProjectOptions(
  projects: RuntimeProjectWork[],
  deviceId: string
): AutomationProjectOption[] {
  return projects.flatMap(project => {
    const workspaces = project.deviceWorkspaces.filter(
      workspace => workspace.deviceId === deviceId && workspace.available
    )
    if (workspaces.length === 0) return []

    const primaryRoot = project.project.roots?.[0]?.path
    const primaryWorkspace = primaryRoot
      ? workspaces.find(
          workspace =>
            normalizeRuntimeWorkspacePath(workspace.workspacePath) ===
            normalizeRuntimeWorkspacePath(primaryRoot)
        )
      : null
    const primary =
      primaryWorkspace ??
      workspaces.find(workspace => !isWorktreeWorkspace(workspace)) ??
      workspaces[0]
    const selectableWorkspaces = [
      primary,
      ...workspaces.filter(
        workspace =>
          workspace !== primary &&
          isWorktreeWorkspace(workspace) &&
          normalizeRuntimeWorkspacePath(workspace.workspacePath) !==
            normalizeRuntimeWorkspacePath(primary.workspacePath)
      ),
    ]

    return selectableWorkspaces.map(workspace => ({
      key: `${runtimeProjectWorkKey(project)}\u0000${normalizeRuntimeWorkspacePath(workspace.workspacePath)}`,
      name: project.project.name,
      workspacePath: workspace.workspacePath,
      workspaceKind: workspace.workspaceKind,
      workspaceLabel: workspace.label?.trim() || null,
    }))
  })
}

function isWorktreeWorkspace(workspace: RuntimeProjectWork['deviceWorkspaces'][number]): boolean {
  return workspace.workspaceKind === 'worktree' || Boolean(workspace.worktreeId)
}

export function buildAutomationTaskOptions(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  deviceIds?: ReadonlySet<string>
): AutomationTaskOption[] {
  if (!runtimeWork) return []

  const projectOptions = runtimeWork.projects.flatMap(project =>
    project.deviceWorkspaces
      .filter(workspace => !deviceIds || deviceIds.has(workspace.deviceId))
      .flatMap(workspace =>
        workspace.tasks
          .filter(task => task.pinned === true && task.continuable !== false)
          .map(task => ({
            key: automationTaskKey({ deviceId: workspace.deviceId, taskId: task.taskId }),
            label: `${task.title} · ${project.project.name}`,
            address: {
              deviceId: workspace.deviceId,
              taskId: task.taskId,
              threadId: task.threadId,
              workspacePath: task.workspacePath || workspace.workspacePath,
              runtimeHandle: task.runtimeHandle,
            },
            pinned: task.pinned === true,
            updatedAt: task.updatedAt,
          }))
      )
  )
  const chatOptions = runtimeWork.chats
    .filter(workspace => !deviceIds || deviceIds.has(workspace.deviceId))
    .flatMap(workspace =>
      workspace.tasks
        .filter(task => task.pinned === true && task.continuable !== false)
        .map(task => ({
          key: automationTaskKey({ deviceId: workspace.deviceId, taskId: task.taskId }),
          label: task.title,
          address: {
            deviceId: workspace.deviceId,
            taskId: task.taskId,
            threadId: task.threadId,
            workspacePath: task.workspacePath || workspace.workspacePath,
            runtimeHandle: task.runtimeHandle,
          },
          pinned: task.pinned === true,
          updatedAt: task.updatedAt,
        }))
    )

  return [...projectOptions, ...chatOptions]
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
    })
    .map(option => ({
      key: option.key,
      label: option.label,
      address: option.address,
    }))
}

export function automationTaskKey(address: RuntimeTaskAddress | null | undefined): string {
  return address
    ? `${encodeURIComponent(address.deviceId)}:${encodeURIComponent(address.taskId)}`
    : ''
}

export function emptyAutomationDraft(
  source: AutomationSource,
  deviceId = '',
  workspacePath = '',
  selectedModel: UnifiedModel | null = null,
  selectedModelOptions: ModelOptions = {}
): AutomationDraft {
  return {
    name: '',
    prompt: '',
    source,
    scheduleType: 'cron',
    cronPreset: 'weekdays',
    cronExpression: '0 9 * * 1-5',
    cronTime: '09:00',
    weeklyDay: '1',
    customFrequency: 'weekly',
    customInterval: '1',
    customWeekdays: ['1', '2', '3', '4', '5'],
    intervalValue: '1',
    intervalUnit: 'hours',
    executeAt: toDateTimeLocal(new Date(Date.now() + 60 * 60 * 1000)),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    deviceId,
    workspacePath,
    conversationMode: 'independent',
    continuationAddress: null,
    goalEnabled: false,
    notificationPolicy: 'all_runs',
    modelId: selectedModel?.modelId ?? selectedModel?.name ?? '',
    modelType: selectedModel?.type ?? '',
    modelOptions: { ...selectedModelOptions },
  }
}

export function automationWorkspaceTarget(
  workspacePath: string
): Pick<RuntimeTaskCreateRequest, 'workspacePath' | 'standaloneChatWorkspace'> {
  const normalizedWorkspacePath = workspacePath.trim()
  return normalizedWorkspacePath
    ? { workspacePath: normalizedWorkspacePath }
    : { standaloneChatWorkspace: true }
}

export function toDateTimeLocal(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function scheduleFromAutomationDraft(draft: AutomationDraft): AutomationSchedule {
  if (draft.scheduleType === 'interval') {
    const parsedValue = Math.max(1, Number.parseInt(draft.intervalValue, 10) || 1)
    return {
      type: 'interval',
      value:
        draft.source === 'cloud' && draft.intervalUnit === 'minutes'
          ? Math.max(15, parsedValue)
          : parsedValue,
      unit: draft.intervalUnit,
    }
  }
  if (draft.scheduleType === 'one_time') {
    return { type: 'one_time', executeAt: new Date(draft.executeAt).toISOString() }
  }
  if (draft.cronPreset === 'custom') {
    const value = Math.max(1, Number.parseInt(draft.customInterval, 10) || 1)
    if (draft.customFrequency === 'hourly') {
      return { type: 'interval', value, unit: 'hours' }
    }
    if (draft.customFrequency === 'daily' && value > 1) {
      return { type: 'interval', value, unit: 'days' }
    }
  }
  return { type: 'cron', expression: cronExpressionFromDraft(draft) }
}

export function automationDraftFromAutomation(automation: Automation): AutomationDraft {
  const payload = (automation.taskRequest ?? automation.taskPayload ?? {}) as unknown as Record<
    string,
    unknown
  >
  const deviceId = String(payload.deviceId ?? payload.device_id ?? '')
  const workspacePath = String(payload.workspacePath ?? payload.workspace_path ?? '')
  const modelOptions =
    payload.modelOptions && typeof payload.modelOptions === 'object'
      ? (payload.modelOptions as ModelOptions)
      : {}
  const draft = emptyAutomationDraft(automation.source, deviceId, workspacePath)
  draft.name = automation.name
  draft.prompt = automation.prompt
  draft.timezone = automation.timezone
  draft.conversationMode = automation.conversationMode
  draft.continuationAddress = continuationAddressFromAutomation(automation)
  const initialGoal = initialGoalFromAutomation(automation)
  draft.goalEnabled = initialGoal !== null
  draft.notificationPolicy = automation.notificationPolicy ?? 'all_runs'
  draft.scheduleType = automation.schedule.type
  draft.modelId = String(payload.modelId ?? '')
  draft.modelType = String(payload.modelType ?? '')
  draft.modelOptions = { ...modelOptions }
  if (automation.schedule.type === 'cron') {
    const cron = parseCronExpression(automation.schedule.expression)
    draft.cronExpression = automation.schedule.expression
    draft.cronPreset = cron.preset
    draft.cronTime = cron.time
    draft.weeklyDay = cron.weeklyDay
    draft.customFrequency = cron.customFrequency
    draft.customInterval = cron.customInterval
    draft.customWeekdays = cron.customWeekdays
  } else if (automation.schedule.type === 'interval') {
    draft.scheduleType = 'cron'
    draft.cronPreset = 'custom'
    draft.intervalValue = String(automation.schedule.value)
    draft.intervalUnit = automation.schedule.unit
    draft.customInterval = String(automation.schedule.value)
    draft.customFrequency = automation.schedule.unit === 'days' ? 'daily' : 'hourly'
  } else {
    draft.executeAt = toDateTimeLocal(new Date(automation.schedule.executeAt))
  }
  return draft
}

export function initialGoalFromAutomationDraft(
  draft: AutomationDraft
): RuntimeGoalCreateInput | null {
  if (!draft.goalEnabled) return null
  const objective = draft.prompt.trim()
  return objective ? { objective, status: 'active', tokenBudget: null } : null
}

function initialGoalFromAutomation(automation: Automation): RuntimeGoalCreateInput | null {
  const taskPayload = (automation.taskRequest ?? automation.taskPayload ?? {}) as unknown as Record<
    string,
    unknown
  >
  const continuationPayload =
    automation.continuationPayload && typeof automation.continuationPayload === 'object'
      ? automation.continuationPayload
      : null
  return runtimeGoalCreateInput(
    continuationPayload?.initialGoal ??
      continuationPayload?.initial_goal ??
      taskPayload.initialGoal ??
      taskPayload.initial_goal
  )
}

function runtimeGoalCreateInput(value: unknown): RuntimeGoalCreateInput | null {
  if (!value || typeof value !== 'object') return null
  const goal = value as Record<string, unknown>
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : ''
  if (!objective) return null
  const tokenBudget = goal.tokenBudget ?? goal.token_budget
  return {
    objective,
    status:
      typeof goal.status === 'string' ? (goal.status as RuntimeGoalCreateInput['status']) : null,
    tokenBudget: typeof tokenBudget === 'number' ? tokenBudget : null,
  }
}

function continuationAddressFromAutomation(automation: Automation): RuntimeTaskAddress | null {
  const payload = automation.continuationPayload
  if (!payload || typeof payload !== 'object') return null
  const addressValue = payload.address
  const address =
    addressValue && typeof addressValue === 'object'
      ? (addressValue as Record<string, unknown>)
      : payload
  const deviceId = String(address.deviceId ?? address.device_id ?? '')
  const taskId = String(
    address.taskId ?? address.task_id ?? payload.taskId ?? payload.task_id ?? ''
  )
  if (!deviceId || !taskId) return null
  const threadId = address.threadId ?? address.thread_id
  const workspacePath = address.workspacePath ?? address.workspace_path
  return {
    deviceId,
    taskId,
    threadId: threadId == null ? null : String(threadId),
    workspacePath: workspacePath == null ? null : String(workspacePath),
  }
}

function timestampValue(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value
  return value ? Date.parse(value) || 0 : 0
}

export function cronExpressionFromDraft(draft: AutomationDraft): string {
  const [hours = '9', minutes = '0'] = draft.cronTime.split(':')
  if (draft.cronPreset === 'custom') {
    const interval = Math.max(1, Number.parseInt(draft.customInterval, 10) || 1)
    if (draft.customFrequency === 'hourly') {
      return `${Number(minutes)} */${interval} * * *`
    }
    if (draft.customFrequency === 'weekly') {
      const weekdays = draft.customWeekdays.length ? draft.customWeekdays.join(',') : '1'
      return `${Number(minutes)} ${Number(hours)} * * ${weekdays}`
    }
    if (draft.customFrequency === 'monthly') {
      return `${Number(minutes)} ${Number(hours)} 1 */${interval} *`
    }
    if (draft.customFrequency === 'yearly') {
      return `${Number(minutes)} ${Number(hours)} 1 1 *`
    }
    return `${Number(minutes)} ${Number(hours)} */${interval} * *`
  }
  const prefix = `${Number(minutes)} ${Number(hours)} * *`
  if (draft.cronPreset === 'weekdays') return `${prefix} 1-5`
  if (draft.cronPreset === 'weekly') return `${prefix} ${draft.weeklyDay}`
  return `${prefix} *`
}

function parseCronExpression(expression: string): {
  preset: CronPreset
  time: string
  weeklyDay: string
  customFrequency: CustomFrequency
  customInterval: string
  customWeekdays: string[]
} {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return {
      preset: 'custom',
      time: '09:00',
      weeklyDay: '1',
      customFrequency: 'weekly',
      customInterval: '1',
      customWeekdays: ['1'],
    }
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
  const defaultCustom = {
    customFrequency: 'weekly' as const,
    customInterval: '1',
    customWeekdays: ['1'],
  }
  const simpleTime =
    /^\d+$/.test(minute) && /^\d+$/.test(hour) && dayOfMonth === '*' && month === '*'
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\*\/\d+$/.test(dayOfMonth) &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return {
      preset: 'custom',
      time: `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`,
      weeklyDay: '1',
      customFrequency: 'daily',
      customInterval: dayOfMonth.slice(2),
      customWeekdays: ['1'],
    }
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === '1' &&
    /^\*\/\d+$/.test(month) &&
    dayOfWeek === '*'
  ) {
    return {
      preset: 'custom',
      time: `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`,
      weeklyDay: '1',
      customFrequency: 'monthly',
      customInterval: month.slice(2),
      customWeekdays: ['1'],
    }
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === '1' &&
    month === '1' &&
    dayOfWeek === '*'
  ) {
    return {
      preset: 'custom',
      time: `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`,
      weeklyDay: '1',
      customFrequency: 'yearly',
      customInterval: '1',
      customWeekdays: ['1'],
    }
  }
  if (!simpleTime) {
    return { preset: 'custom', time: '09:00', weeklyDay: '1', ...defaultCustom }
  }
  const time = `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`
  if (dayOfWeek === '1-5') {
    return { preset: 'weekdays', time, weeklyDay: '1', ...defaultCustom }
  }
  if (dayOfWeek === '*') {
    return { preset: 'daily', time, weeklyDay: '1', ...defaultCustom }
  }
  if (/^[0-6]$/.test(dayOfWeek)) {
    return { preset: 'weekly', time, weeklyDay: dayOfWeek, ...defaultCustom }
  }
  if (/^[0-6](,[0-6])+$/.test(dayOfWeek)) {
    return {
      preset: 'custom',
      time,
      weeklyDay: dayOfWeek.split(',')[0],
      customFrequency: 'weekly',
      customInterval: '1',
      customWeekdays: dayOfWeek.split(','),
    }
  }
  return { preset: 'custom', time, weeklyDay: '1', ...defaultCustom }
}
