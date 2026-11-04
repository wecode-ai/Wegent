// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ArrowRightLeft, CalendarClock, Sparkles, Tag, Webhook } from 'lucide-react'
import type { AutomationEventType } from '../automation/types'
import type {
  WorkspaceAutomationInput,
  WorkspaceAutomationRule,
  WorkspaceIncomingHook,
} from '../ports/SharedWorkspaceApi'

export type TriggerKind = 'created' | 'tag_added' | 'status_changed' | 'external' | 'schedule'
export type TargetKind = 'human' | 'agent' | 'collaboration_group'
export type ScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'custom'

interface ScheduleValue {
  frequency: ScheduleFrequency
  time: string
  weekday: string
}

export const WEEKDAY_OPTIONS = [
  ['1', '周一', 'Monday'],
  ['2', '周二', 'Tuesday'],
  ['3', '周三', 'Wednesday'],
  ['4', '周四', 'Thursday'],
  ['5', '周五', 'Friday'],
  ['6', '周六', 'Saturday'],
  ['0', '周日', 'Sunday'],
] as const

export const TRIGGER_OPTIONS = [
  {
    kind: 'created',
    icon: Sparkles,
    title: ['Issue 创建后', 'Issue created'],
    description: ['新 Issue 进入项目时', 'When a new issue enters the project'],
  },
  {
    kind: 'tag_added',
    icon: Tag,
    title: ['添加 Tag 后', 'Tag added'],
    description: ['Issue 添加指定 Tag 时', 'When a matching tag is added'],
  },
  {
    kind: 'status_changed',
    icon: ArrowRightLeft,
    title: ['进入指定状态后', 'Status reached'],
    description: ['Issue 进入指定状态时', 'When an issue enters the selected status'],
  },
  {
    kind: 'external',
    icon: Webhook,
    title: ['外部事件发生后', 'External event'],
    description: ['收到已接入系统的事件时', 'When a connected system fires'],
  },
  {
    kind: 'schedule',
    icon: CalendarClock,
    title: ['定时处理', 'Scheduled'],
    description: ['按指定时间周期触发', 'Run on a configured schedule'],
  },
] as const satisfies ReadonlyArray<{
  kind: TriggerKind
  icon: typeof Sparkles
  title: readonly [string, string]
  description: readonly [string, string]
}>

export interface AutomaticProcessingDraft {
  id: string | null
  version: number | null
  name: string
  prompt: string
  trigger: TriggerKind
  tag: string
  statuses: string[]
  statusTransition: 'any' | 'entered_processing'
  cronExpression: string
  hookId: string
  eventType: AutomationEventType | ''
  targetKind: TargetKind
  targetId: string
  enabled: boolean
  runnerSelection?: WorkspaceAutomationInput['runnerSelection']
}

export const EMPTY_DRAFT: AutomaticProcessingDraft = {
  id: null,
  version: null,
  name: '',
  prompt: '',
  trigger: 'created',
  tag: '',
  statuses: [],
  statusTransition: 'any',
  cronExpression: '0 9 * * 1-5',
  hookId: '',
  eventType: '',
  targetKind: 'agent',
  targetId: '',
  enabled: true,
}

function text(rule: Record<string, unknown>, camel: string, snake: string) {
  const value = rule[camel] ?? rule[snake]
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function sourceType(hook: WorkspaceIncomingHook) {
  return text(hook as unknown as Record<string, unknown>, 'sourceType', 'source_type')
}

export function eventTypesForHook(hook: WorkspaceIncomingHook): AutomationEventType[] {
  const source = sourceType(hook)
  if (source === 'github') {
    return [
      'change_request.checks_failed',
      'change_request.merge_conflict',
      'change_request.review_submitted',
      'change_request.comment_created',
    ]
  }
  if (source === 'gitlab') {
    return [
      'change_request.checks_failed',
      'change_request.merge_conflict',
      'change_request.comment_created',
    ]
  }
  return ['document.changed']
}

export function eventLabel(value: string, locale: 'zh-CN' | 'en') {
  const labels: Record<string, [string, string]> = {
    'change_request.checks_failed': ['代码检查失败', 'Checks failed'],
    'change_request.merge_conflict': ['发生合并冲突', 'Merge conflict'],
    'change_request.review_submitted': ['提交代码评审', 'Review submitted'],
    'change_request.comment_created': ['新增代码评论', 'Comment created'],
    'document.changed': ['外部文档变化', 'External document changed'],
  }
  const label = labels[value]
  return label ? label[locale === 'zh-CN' ? 0 : 1] : value
}

export function parseSchedule(cronExpression: string): ScheduleValue {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = cronExpression.trim().split(/\s+/)
  const minuteNumber = Number(minute)
  const hourNumber = Number(hour)
  const validTime =
    Number.isInteger(minuteNumber) &&
    minuteNumber >= 0 &&
    minuteNumber <= 59 &&
    Number.isInteger(hourNumber) &&
    hourNumber >= 0 &&
    hourNumber <= 23
  const time = validTime
    ? `${String(hourNumber).padStart(2, '0')}:${String(minuteNumber).padStart(2, '0')}`
    : '09:00'

  if (rest.length || !validTime || dayOfMonth !== '*' || month !== '*') {
    return { frequency: 'custom', time, weekday: '1' }
  }
  if (dayOfWeek === '*') {
    return { frequency: 'daily', time, weekday: '1' }
  }
  if (dayOfWeek === '1-5') {
    return { frequency: 'weekdays', time, weekday: '1' }
  }
  if (WEEKDAY_OPTIONS.some(([value]) => value === dayOfWeek)) {
    return { frequency: 'weekly', time, weekday: dayOfWeek }
  }
  return { frequency: 'custom', time, weekday: '1' }
}

export function buildScheduleCron({ frequency, time, weekday }: ScheduleValue): string {
  const [hour = '09', minute = '00'] = time.split(':')
  const dayOfWeek = frequency === 'daily' ? '*' : frequency === 'weekdays' ? '1-5' : weekday
  return `${Number(minute)} ${Number(hour)} * * ${dayOfWeek}`
}

export function scheduleLabel(cronExpression: string, locale: 'zh-CN' | 'en'): string {
  const schedule = parseSchedule(cronExpression)
  if (schedule.frequency === 'custom') {
    return locale === 'zh-CN'
      ? `自定义时间 · ${cronExpression.trim()}`
      : `Custom schedule · ${cronExpression.trim()}`
  }
  const time = schedule.time
  if (schedule.frequency === 'daily') {
    return locale === 'zh-CN' ? `每天 ${time}` : `Every day at ${time}`
  }
  if (schedule.frequency === 'weekdays') {
    return locale === 'zh-CN' ? `工作日 ${time}` : `Weekdays at ${time}`
  }
  const weekday =
    WEEKDAY_OPTIONS.find(([value]) => value === schedule.weekday) ?? WEEKDAY_OPTIONS[0]
  return locale === 'zh-CN' ? `每${weekday[1]} ${time}` : `Every ${weekday[2]} at ${time}`
}

export function draftFromRule(rule: WorkspaceAutomationRule): AutomaticProcessingDraft {
  const eventConfig = record(rule.eventConfig)
  const tags = Array.isArray(eventConfig.tags) ? eventConfig.tags : []
  const statuses = Array.isArray(eventConfig.statuses) ? eventConfig.statuses : []
  const trigger: TriggerKind =
    rule.triggerType === 'schedule'
      ? 'schedule'
      : rule.eventType === 'task.tag_added'
        ? 'tag_added'
        : rule.eventType === 'task.status_changed'
          ? 'status_changed'
          : rule.eventType === 'task.created'
            ? 'created'
            : 'external'
  return {
    id: rule.id,
    version: rule.version,
    name: rule.name,
    prompt: rule.prompt ?? '',
    trigger,
    tag: typeof tags[0] === 'string' ? tags[0] : '',
    statuses: statuses.filter((status): status is string => typeof status === 'string'),
    statusTransition:
      eventConfig.transition === 'entered_processing' ? 'entered_processing' : 'any',
    cronExpression: rule.cronExpression ?? '',
    hookId: String(eventConfig.subscriptionId ?? eventConfig.subscription_id ?? ''),
    eventType: trigger === 'external' ? (rule.eventType ?? '') : '',
    targetKind: rule.targetKind,
    targetId: rule.targetId,
    enabled: rule.enabled,
    runnerSelection: rule.runnerSelection,
  }
}
