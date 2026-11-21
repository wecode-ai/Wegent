import { CollapsibleRoot, CollapsibleTrigger, CollapsiblePanel } from '../controls/Collapsible'
import { RadioGroup, Radio } from '../controls/RadioGroup'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { CalendarClock } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { WorkdayOnlyField } from './WorkdayOnlyField'

import type { AutomationEventType } from '../automation/types'
import type { CollaborationTranslate } from '../i18n'
import type { WorkspaceIncomingHook } from '../ports/SharedWorkspaceApi'
import type { CollaborationStatus } from '../types'
import type {
  AutomaticProcessingDraft,
  ScheduleFrequency,
  TriggerKind,
} from './automaticProcessing'
import {
  buildScheduleCron,
  eventLabel,
  eventTypesForHook,
  parseSchedule,
  scheduleLabel,
  TRIGGER_OPTIONS,
  WEEKDAY_OPTIONS,
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
  const [cronExpansion, setCronExpansion] = useState({ error: cronError, open: Boolean(cronError) })
  if (cronExpansion.error !== cronError) {
    setCronExpansion({ error: cronError, open: cronError ? true : cronExpansion.open })
  }
  const attachCronInput = useCallback(
    (input: HTMLInputElement | null) => {
      cronInput.current = input
      if (!input || !cronError) return
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
      <RadioGroup
        value={draft.trigger}
        name="automatic-processing-trigger"
        aria-label={translate('todo.when', '当发生')}
        onValueChange={next => {
          const option = TRIGGER_OPTIONS.find(option => option.kind === next)
          if (option) selectTrigger(option.kind)
        }}
        render={<fieldset />}
        className="flex flex-wrap gap-2"
        data-testid="automatic-processing-trigger"
      >
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
                <Radio
                  value={option.kind}
                  autoFocus={index === 0}
                  data-testid={`automatic-processing-trigger-${option.kind}`}
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
      </RadioGroup>

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
              <ControlInput
                density="compact"
                className="min-w-0 flex-1"
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
              <SelectRoot
                value={normalizeSelectValue(
                  draft.statusTransition === 'entered_processing'
                    ? '__entered_processing__'
                    : (draft.statuses[0] ?? '')
                )}
                onValueChange={selectedValue => {
                  if (selectedValue === null) return
                  const value = selectedValue
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
                <SelectTrigger
                  density="compact"
                  className="min-w-0 flex-1"
                  data-testid="automatic-processing-status"
                  id="automatic-processing-status"
                />
                <SelectContent>
                  <SelectItem value="">
                    {translate('todo.select_matching_status', '请选择状态')}
                  </SelectItem>
                  {draft.statusTransition === 'entered_processing' ? (
                    <SelectItem value="__entered_processing__">
                      {translate('todo.trigger_entered_processing', '进入处理阶段')}
                    </SelectItem>
                  ) : null}
                  {statuses.map(status => (
                    <SelectItem key={status.id} value={String(status.id)}>
                      {status.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectRoot>
            </div>
          ) : null}

          {draft.trigger === 'schedule' ? (
            <div className="space-y-4 py-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-sm">
                  <span className="block font-medium text-text-primary">
                    {translate('todo.schedule_frequency', '重复')}
                  </span>
                  <SelectRoot
                    value={normalizeSelectValue(schedule.frequency)}
                    onValueChange={selectedValue => {
                      if (selectedValue === null) return
                      const frequency = selectedValue as ScheduleFrequency
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
                    <SelectTrigger
                      className="h-10 w-full"
                      data-testid="automatic-processing-schedule-frequency"
                    />
                    <SelectContent>
                      <SelectItem value="daily">
                        {translate('todo.schedule_daily', '每天')}
                      </SelectItem>
                      <SelectItem value="weekdays">
                        {translate(
                          'todo.schedule_weekdays',
                          locale === 'zh-CN' ? '周一至周五' : 'Monday–Friday'
                        )}
                      </SelectItem>
                      <SelectItem value="weekly">
                        {translate('todo.schedule_weekly', '每周')}
                      </SelectItem>
                      {schedule.frequency === 'custom' ? (
                        <SelectItem value="custom">
                          {translate('todo.schedule_custom', '自定义 Cron')}
                        </SelectItem>
                      ) : null}
                    </SelectContent>
                  </SelectRoot>
                </label>

                <label className="space-y-1.5 text-sm">
                  <span className="block font-medium text-text-primary">
                    {translate('todo.schedule_time', '执行时间')}
                  </span>
                  <ControlInput
                    className="h-10 w-full tabular-nums"
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
                  <SelectRoot
                    value={normalizeSelectValue(schedule.weekday)}
                    onValueChange={selectedValue => {
                      if (selectedValue !== null)
                        return updateDraft({
                          cronExpression: buildScheduleCron({
                            ...schedule,
                            weekday: selectedValue,
                          }),
                        })
                    }}
                  >
                    <SelectTrigger
                      className="h-10 w-full"
                      data-testid="automatic-processing-schedule-weekday"
                    />
                    <SelectContent>
                      {WEEKDAY_OPTIONS.map(([value, zhLabel, enLabel]) => (
                        <SelectItem key={value} value={String(value)}>
                          {locale === 'zh-CN' ? zhLabel : enLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </SelectRoot>
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

              <CollapsibleRoot
                open={cronExpansion.open}
                onOpenChange={open => setCronExpansion({ error: cronError, open })}
                className="group rounded-lg border border-border bg-background"
                data-testid="automatic-processing-cron-advanced"
              >
                <CollapsibleTrigger
                  className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm font-medium text-text-secondary"
                  data-testid="automatic-processing-cron-advanced-toggle"
                >
                  {translate('todo.schedule_advanced', '高级设置（Cron）')}
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="space-y-2 border-t border-border px-3 py-3">
                    <label className="sr-only" htmlFor="automatic-processing-cron">
                      {translate('todo.schedule_expression', 'Cron 表达式')}
                    </label>
                    <ControlInput
                      ref={attachCronInput}
                      aria-invalid={cronError ? true : undefined}
                      aria-describedby={cronError ? 'automatic-processing-cron-error' : undefined}
                      className="h-9 w-full font-mono"
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
                </CollapsiblePanel>
              </CollapsibleRoot>
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
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    className="collaboration-link-button"
                    data-testid="automatic-processing-hooks-retry"
                    onClick={refreshHooks}
                  >
                    {translate('todo.event_sources_refresh', '刷新来源')}
                  </ControlButton>
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
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      className="collaboration-link-button"
                      data-testid="automatic-processing-hooks-refresh"
                      onClick={refreshHooks}
                    >
                      {translate('todo.event_sources_refresh', '刷新来源')}
                    </ControlButton>
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
                <SelectRoot
                  disabled={hooksLoading || hooks.length === 0}
                  value={normalizeSelectValue(draft.hookId)}
                  items={hooks.map(hook => ({ value: String(hook.id), label: hook.name }))}
                  onValueChange={selectedValue => {
                    if (selectedValue === null) return
                    const hook = hooks.find(candidate => candidate.id === selectedValue)
                    updateDraft({
                      hookId: selectedValue,
                      eventType: hook ? (eventTypesForHook(hook)[0] ?? '') : '',
                    })
                  }}
                >
                  <SelectTrigger
                    density="compact"
                    className="min-w-0 flex-1"
                    data-testid="automatic-processing-hook"
                    data-value={draft.hookId}
                    id="automatic-processing-hook"
                  />
                  <SelectContent>
                    <SelectItem value="">
                      {hooksLoading
                        ? translate('common.loading', '加载中…')
                        : translate('common.select', '请选择')}
                    </SelectItem>
                    {hooks.map(hook => (
                      <SelectItem key={hook.id} value={String(hook.id)}>
                        {hook.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </div>
              <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                <label
                  className="w-14 shrink-0 font-medium text-text-primary"
                  htmlFor="automatic-processing-event"
                >
                  {translate('todo.event_type', '事件')}
                </label>
                <SelectRoot
                  disabled={hooksLoading || !draft.hookId}
                  value={normalizeSelectValue(draft.eventType)}
                  onValueChange={selectedValue => {
                    if (selectedValue !== null)
                      return updateDraft({
                        eventType: selectedValue as AutomationEventType,
                      })
                  }}
                >
                  <SelectTrigger
                    density="compact"
                    className="min-w-0 flex-1"
                    data-testid="automatic-processing-event"
                    id="automatic-processing-event"
                  />
                  <SelectContent>
                    <SelectItem value="">{translate('common.select', '请选择')}</SelectItem>
                    {externalEventTypes.map(eventType => (
                      <SelectItem key={eventType} value={String(eventType)}>
                        {eventLabel(eventType, locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
