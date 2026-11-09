// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { CalendarClock, ChevronDown } from 'lucide-react'

import type { AutomationEventType } from '../automation/types'
import type { CollaborationTranslate } from '../i18n'
import type { WorkspaceIncomingHook } from '../ports/SharedWorkspaceApi'
import type { CollaborationStatus } from '../types'
import {
  buildScheduleCron,
  eventLabel,
  eventTypesForHook,
  parseSchedule,
  scheduleLabel,
  TRIGGER_OPTIONS,
  WEEKDAY_OPTIONS,
} from './automaticProcessing'
import type {
  AutomaticProcessingDraft,
  ScheduleFrequency,
  TriggerKind,
} from './automaticProcessing'

interface AutomaticProcessingTriggerFieldsProps {
  draft: AutomaticProcessingDraft
  updateDraft(patch: Partial<AutomaticProcessingDraft>): void
  selectTrigger(trigger: TriggerKind): void
  locale: 'zh-CN' | 'en'
  translate: CollaborationTranslate
  hooks: WorkspaceIncomingHook[]
  hooksLoading: boolean
  hasIncomingHooks: boolean
  statuses: CollaborationStatus[]
}

export function AutomaticProcessingTriggerFields({
  draft,
  updateDraft,
  selectTrigger,
  locale,
  translate,
  hooks,
  hooksLoading,
  hasIncomingHooks,
  statuses,
}: AutomaticProcessingTriggerFieldsProps) {
  const schedule = parseSchedule(draft.cronExpression)
  const selectedHook = hooks.find(hook => hook.id === draft.hookId)
  const externalEventTypes = selectedHook ? eventTypesForHook(selectedHook) : []

  return (
    <>
      <fieldset className="grid grid-cols-2 gap-2" data-testid="automatic-processing-trigger">
        <legend className="mb-2 text-sm font-medium text-text-primary">
          {translate('todo.when', '当发生')}
        </legend>
        {TRIGGER_OPTIONS.filter(option => option.kind !== 'external' || hasIncomingHooks).map(
          (option, index) => {
            const selected = draft.trigger === option.kind
            const Icon = option.icon
            const localeIndex = locale === 'zh-CN' ? 0 : 1
            return (
              <label
                className={`!flex min-h-[68px] cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors ${
                  selected ? 'automatic-processing-selected' : 'border-border hover:bg-muted/60'
                }`}
                key={option.kind}
              >
                <input
                  autoFocus={index === 0}
                  checked={selected}
                  className="sr-only"
                  data-testid={`automatic-processing-trigger-${option.kind}`}
                  name="automatic-processing-trigger"
                  onChange={() => selectTrigger(option.kind)}
                  type="radio"
                  value={option.kind}
                />
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    selected ? 'automatic-processing-selected-icon' : 'text-text-secondary'
                  }`}
                />
                <span className="min-w-0">
                  <strong className="block text-sm font-medium text-text-primary">
                    {option.kind === 'status_changed'
                      ? translate('todo.trigger_status_changed', option.title[localeIndex])
                      : option.title[localeIndex]}
                  </strong>
                  <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
                    {option.kind === 'status_changed'
                      ? translate(
                          'todo.trigger_status_changed_description',
                          option.description[localeIndex]
                        )
                      : option.description[localeIndex]}
                  </span>
                </span>
              </label>
            )
          }
        )}
      </fieldset>

      {draft.trigger !== 'created' ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border px-4">
          {draft.trigger === 'tag_added' ? (
            <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
              <label
                className="w-14 shrink-0 font-medium text-text-primary"
                htmlFor="automatic-processing-tag"
              >
                {translate('todo.matching_tag', 'Tag')}
              </label>
              <input
                className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none keyboard:focus:border-focus"
                data-testid="automatic-processing-tag"
                id="automatic-processing-tag"
                placeholder={translate('todo.matching_tag_placeholder', '输入需要匹配的 Tag')}
                value={draft.tag}
                onChange={event => updateDraft({ tag: event.target.value })}
              />
            </div>
          ) : null}

          {draft.trigger === 'status_changed' ? (
            <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
              <label
                className="w-14 shrink-0 font-medium text-text-primary"
                htmlFor="automatic-processing-status"
              >
                {translate('todo.matching_status', '状态')}
              </label>
              <select
                className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none keyboard:focus:border-focus md:h-8"
                data-testid="automatic-processing-status"
                id="automatic-processing-status"
                value={
                  draft.statusTransition === 'entered_processing'
                    ? '__entered_processing__'
                    : (draft.statuses[0] ?? '')
                }
                onChange={event => {
                  const value = event.target.value
                  updateDraft(
                    value === '__entered_processing__'
                      ? { statuses: [], statusTransition: 'entered_processing' }
                      : { statuses: value ? [value] : [], statusTransition: 'any' }
                  )
                }}
              >
                <option className="bg-background text-text-primary" value="">
                  {translate('todo.select_matching_status', '请选择状态')}
                </option>
                {draft.statusTransition === 'entered_processing' ? (
                  <option
                    className="bg-background text-text-primary"
                    value="__entered_processing__"
                  >
                    {translate('todo.trigger_entered_processing', '进入处理阶段')}
                  </option>
                ) : null}
                {statuses.map(status => (
                  <option
                    className="bg-background text-text-primary"
                    key={status.id}
                    value={status.id}
                  >
                    {status.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {draft.trigger === 'schedule' ? (
            <div className="space-y-4 py-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                  <span className="block font-medium text-text-primary">
                    {translate('todo.schedule_frequency', '重复')}
                  </span>
                  <select
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 outline-none keyboard:focus:border-focus"
                    data-testid="automatic-processing-schedule-frequency"
                    value={schedule.frequency}
                    onChange={event => {
                      const frequency = event.target.value as ScheduleFrequency
                      if (frequency === 'custom') {
                        return
                      }
                      updateDraft({
                        cronExpression: buildScheduleCron({
                          ...schedule,
                          frequency,
                        }),
                      })
                    }}
                  >
                    <option value="daily">{translate('todo.schedule_daily', '每天')}</option>
                    <option value="weekdays">
                      {translate('todo.schedule_weekdays', '每个工作日')}
                    </option>
                    <option value="weekly">{translate('todo.schedule_weekly', '每周')}</option>
                    {schedule.frequency === 'custom' ? (
                      <option value="custom">
                        {translate('todo.schedule_custom', '自定义 Cron')}
                      </option>
                    ) : null}
                  </select>
                </label>

                <label className="space-y-1.5 text-sm">
                  <span className="block font-medium text-text-primary">
                    {translate('todo.schedule_time', '执行时间')}
                  </span>
                  <input
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 tabular-nums outline-none keyboard:focus:border-focus"
                    data-testid="automatic-processing-schedule-time"
                    onChange={event =>
                      updateDraft({
                        cronExpression: buildScheduleCron({
                          ...schedule,
                          frequency:
                            schedule.frequency === 'custom' ? 'weekdays' : schedule.frequency,
                          time: event.target.value,
                        }),
                      })
                    }
                    type="time"
                    value={schedule.time}
                  />
                </label>
              </div>

              {schedule.frequency === 'weekly' ? (
                <label className="block space-y-1.5 text-sm">
                  <span className="block font-medium text-text-primary">
                    {translate('todo.schedule_weekday', '星期')}
                  </span>
                  <select
                    className="h-10 w-full rounded-lg border border-border bg-background px-3 outline-none keyboard:focus:border-focus"
                    data-testid="automatic-processing-schedule-weekday"
                    value={schedule.weekday}
                    onChange={event =>
                      updateDraft({
                        cronExpression: buildScheduleCron({
                          ...schedule,
                          weekday: event.target.value,
                        }),
                      })
                    }
                  >
                    {WEEKDAY_OPTIONS.map(([value, zhLabel, enLabel]) => (
                      <option key={value} value={value}>
                        {locale === 'zh-CN' ? zhLabel : enLabel}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-text-secondary">
                <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span>{scheduleLabel(draft.cronExpression, locale)}</span>
                <span className="ml-auto text-xs text-text-muted">Asia/Shanghai</span>
              </div>

              <details
                className="group rounded-lg border border-border bg-background"
                data-testid="automatic-processing-cron-advanced"
              >
                <summary
                  className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm font-medium text-text-secondary"
                  data-testid="automatic-processing-cron-advanced-toggle"
                >
                  {translate('todo.schedule_advanced', '高级设置（Cron）')}
                  <ChevronDown
                    aria-hidden="true"
                    className="h-4 w-4 transition-transform group-open:rotate-180"
                  />
                </summary>
                <div className="space-y-2 border-t border-border px-3 py-3">
                  <label className="sr-only" htmlFor="automatic-processing-cron">
                    {translate('todo.schedule_expression', 'Cron 表达式')}
                  </label>
                  <input
                    className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm outline-none keyboard:focus:border-focus"
                    data-testid="automatic-processing-cron"
                    id="automatic-processing-cron"
                    placeholder="0 9 * * 1-5"
                    value={draft.cronExpression}
                    onChange={event =>
                      updateDraft({
                        cronExpression: event.target.value,
                      })
                    }
                  />
                  <p className="text-xs text-text-muted">
                    {translate(
                      'todo.schedule_cron_help',
                      '格式：分钟 小时 日 月 星期，例如 0 9 * * 1-5。'
                    )}
                  </p>
                </div>
              </details>
            </div>
          ) : null}

          {draft.trigger === 'external' ? (
            <>
              <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                <label
                  className="w-14 shrink-0 font-medium text-text-primary"
                  htmlFor="automatic-processing-hook"
                >
                  {translate('todo.event_source', '来源')}
                </label>
                <select
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3"
                  data-testid="automatic-processing-hook"
                  id="automatic-processing-hook"
                  disabled={hooksLoading}
                  value={draft.hookId}
                  onChange={event => {
                    const hook = hooks.find(candidate => candidate.id === event.target.value)
                    updateDraft({
                      hookId: event.target.value,
                      eventType: hook ? (eventTypesForHook(hook)[0] ?? '') : '',
                    })
                  }}
                >
                  <option value="">
                    {hooksLoading
                      ? translate('common.loading', '加载中…')
                      : translate('common.select', '请选择')}
                  </option>
                  {hooks.map(hook => (
                    <option key={hook.id} value={hook.id}>
                      {hook.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                <label
                  className="w-14 shrink-0 font-medium text-text-primary"
                  htmlFor="automatic-processing-event"
                >
                  {translate('todo.event_type', '事件')}
                </label>
                <select
                  className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3"
                  data-testid="automatic-processing-event"
                  id="automatic-processing-event"
                  disabled={hooksLoading}
                  value={draft.eventType}
                  onChange={event =>
                    updateDraft({
                      eventType: event.target.value as AutomationEventType,
                    })
                  }
                >
                  <option value="">{translate('common.select', '请选择')}</option>
                  {externalEventTypes.map(eventType => (
                    <option key={eventType} value={eventType}>
                      {eventLabel(eventType, locale)}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
