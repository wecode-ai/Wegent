// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { CalendarClock, ChevronDown } from 'lucide-react'
import { useCallback, useRef } from 'react'
import { WorkdayOnlyField } from './WorkdayOnlyField'

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
  cronError?: string
  draft: AutomaticProcessingDraft
  updateDraft(patch: Partial<AutomaticProcessingDraft>): void
  selectTrigger(trigger: TriggerKind): void
  locale: 'zh-CN' | 'en'
  translate: CollaborationTranslate
  hooks: WorkspaceIncomingHook[]
  hooksLoading: boolean
  hooksError: string
  hasIncomingHooks: boolean
  refreshHooks(): void
  statuses: CollaborationStatus[]
}

export function AutomaticProcessingTriggerFields({
  cronError,
  draft,
  updateDraft,
  selectTrigger,
  locale,
  translate,
  hooks,
  hooksLoading,
  hooksError,
  hasIncomingHooks,
  refreshHooks,
  statuses,
}: AutomaticProcessingTriggerFieldsProps) {
  const cronInput = useRef<HTMLInputElement>(null)
  const attachCronDetails = useCallback(
    (details: HTMLDetailsElement | null) => {
      if (!details || !cronError) return
      details.open = true
      cronInput.current?.focus()
      cronInput.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
    },
    [cronError]
  )
  const schedule = parseSchedule(draft.cronExpression)
  const selectedHook = hooks.find(hook => hook.id === draft.hookId)
  const externalEventTypes = selectedHook ? eventTypesForHook(selectedHook) : []

  return (
    <>
      <fieldset className="flex flex-wrap gap-2" data-testid="automatic-processing-trigger">
        <legend className="mb-2 text-sm font-medium text-text-primary">
          {translate('todo.when', '当发生')}
        </legend>
        {TRIGGER_OPTIONS.filter(option => option.kind !== 'external' || hasIncomingHooks).map(
          (option, index) => {
            const selected = draft.trigger === option.kind
            const localeIndex = locale === 'zh-CN' ? 0 : 1
            return (
              <label
                className={`!flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 transition-colors focus-within:ring-2 focus-within:ring-focus md:min-h-9 ${
                  selected ? 'automatic-processing-selected' : 'border-border hover:bg-muted/60'
                }`}
                key={option.kind}
              >
                <input
                  autoFocus={index === 0}
                  checked={selected}
                  className="h-4 w-4 accent-current"
                  data-testid={`automatic-processing-trigger-${option.kind}`}
                  name="automatic-processing-trigger"
                  onChange={() => selectTrigger(option.kind)}
                  type="radio"
                  value={option.kind}
                />
                <span className="min-w-0">
                  <strong className="block text-sm font-medium text-text-primary">
                    {option.kind === 'status_changed'
                      ? translate('todo.trigger_status_changed', option.title[localeIndex])
                      : option.title[localeIndex]}
                  </strong>
                </span>
              </label>
            )
          }
        )}
      </fieldset>

      <p className="text-sm leading-5 text-text-secondary" aria-live="polite">
        {
          TRIGGER_OPTIONS.find(option => option.kind === draft.trigger)?.description[
            locale === 'zh-CN' ? 0 : 1
          ]
        }
      </p>

      {draft.trigger !== 'created' ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border px-4">
          {draft.trigger === 'tag_added' ? (
            <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
              <label
                className="w-14 shrink-0 font-medium text-text-primary"
                htmlFor="automatic-processing-tag"
              >
                {translate('todo.matching_tag', '标签')}
              </label>
              <input
                className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none keyboard:focus:border-focus"
                data-testid="automatic-processing-tag"
                id="automatic-processing-tag"
                placeholder={translate('todo.matching_tag_placeholder', '输入需要匹配的标签')}
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
                      : {
                          statuses: value ? [value] : [],
                          statusTransition: 'any',
                        }
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
                      {translate(
                        'todo.schedule_weekdays',
                        locale === 'zh-CN' ? '周一至周五' : 'Monday–Friday'
                      )}
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

              <WorkdayOnlyField
                checked={draft.workdayOnly}
                onChange={workdayOnly => updateDraft({ workdayOnly })}
                label={translate(
                  'todo.automation_workday_only',
                  locale === 'zh-CN'
                    ? '仅中国大陆法定工作日执行'
                    : 'Run only on mainland China statutory workdays'
                )}
                description={translate(
                  'todo.automation_workday_only_hint',
                  locale === 'zh-CN'
                    ? '按北京时间日期跳过法定休息日，包含补班周末。选择“每天”可覆盖全部补班日；其他重复规则仍限制执行日期。'
                    : 'Uses Beijing dates, excludes statutory days off and includes make-up working weekends. Choose Daily to include every make-up workday; other recurrence rules still limit dates.'
                )}
                testId="automatic-processing-workday-only"
              />

              <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-text-secondary">
                <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span>{scheduleLabel(draft.cronExpression, locale, draft.workdayOnly)}</span>
                <span className="ml-auto text-xs text-text-muted">{draft.timezone}</span>
              </div>

              <details
                ref={attachCronDetails}
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
                    ref={cronInput}
                    aria-invalid={cronError ? true : undefined}
                    aria-describedby={cronError ? 'automatic-processing-cron-error' : undefined}
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
                  {cronError ? (
                    <p
                      id="automatic-processing-cron-error"
                      className="collaboration-alert"
                      role="alert"
                    >
                      {cronError}
                    </p>
                  ) : null}
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
              {hooksError ? (
                <div
                  className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm text-destructive"
                  role="alert"
                  title={hooksError}
                >
                  <p>{translate('todo.event_sources_load_failed', '读取事件来源失败，请重试。')}</p>
                  <button
                    type="button"
                    className="collaboration-link-button"
                    data-testid="automatic-processing-hooks-retry"
                    onClick={refreshHooks}
                  >
                    {translate('todo.event_sources_refresh', '刷新来源')}
                  </button>
                </div>
              ) : !hooksLoading && hooks.length === 0 ? (
                <div
                  className="space-y-2 rounded-md border border-border p-3 text-sm text-text-secondary"
                  role="status"
                  data-testid="automatic-processing-hooks-empty"
                >
                  <p>
                    {translate(
                      'todo.event_sources_empty',
                      '当前项目尚未接入事件来源。请由项目管理员完成来源接入，再刷新列表。'
                    )}
                  </p>
                  <div className="flex flex-wrap items-center gap-4">
                    <a
                      className="collaboration-link-button"
                      data-testid="automatic-processing-hooks-help"
                      href={`https://github.com/wecode-ai/Wegent/blob/main/docs/${locale === 'zh-CN' ? 'zh' : 'en'}/wework/workbench.md#${locale === 'zh-CN' ? '从外部系统创建-issue' : 'create-issues-from-external-systems'}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {translate('todo.event_sources_setup_help', '查看接入说明')}
                    </a>
                    <button
                      type="button"
                      className="collaboration-link-button"
                      data-testid="automatic-processing-hooks-refresh"
                      onClick={refreshHooks}
                    >
                      {translate('todo.event_sources_refresh', '刷新来源')}
                    </button>
                  </div>
                </div>
              ) : null}
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
                  disabled={hooksLoading || hooks.length === 0}
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
                  disabled={hooksLoading || !draft.hookId}
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
