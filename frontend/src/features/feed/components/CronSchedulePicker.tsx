'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * User-friendly cron schedule picker component with Google Calendar style.
 * Provides toggle button groups, weekday multi-select, time quick select,
 * and execution time preview.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Toggle } from '@/components/ui/toggle'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { ChevronRight, Calendar, Clock } from 'lucide-react'
import { CronExpressionParser } from 'cron-parser'

interface CronSchedulePickerProps {
  value: string
  onChange: (expression: string) => void
  className?: string
  timezone?: string
}

type FrequencyType = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

interface ScheduleState {
  frequency: FrequencyType
  hour: number
  minute: number
  weekdays: number[]
  monthDay: number
  hourlyInterval: number
  customExpression: string
}

// Common hour quick select options
const COMMON_HOURS = [6, 9, 12, 15, 18, 21]

// Common minute quick select options
const COMMON_MINUTES = [0, 15, 30, 45]

// Hourly interval options
const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12]

// Common month day options
const COMMON_MONTH_DAYS = [1, 5, 10, 15, 20, 25]

// Weekday definitions (0 = Sunday, 1 = Monday, etc.)
const WEEKDAYS = [
  { value: 1, key: 'mon' },
  { value: 2, key: 'tue' },
  { value: 3, key: 'wed' },
  { value: 4, key: 'thu' },
  { value: 5, key: 'fri' },
  { value: 6, key: 'sat' },
  { value: 0, key: 'sun' },
]

/**
 * Parse cron expression to schedule state
 */
function parseCronExpression(expression: string): ScheduleState {
  const defaultState: ScheduleState = {
    frequency: 'daily',
    hour: 9,
    minute: 0,
    weekdays: [1], // Monday
    monthDay: 1,
    hourlyInterval: 2,
    customExpression: expression,
  }

  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { ...defaultState, frequency: 'custom' }
  }

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts

  // Parse minute
  const parsedMinute = parseInt(minute)
  const minuteValue = isNaN(parsedMinute) ? 0 : parsedMinute

  // Hourly pattern: "M */N * * *" or "M * * * *"
  if (hour === '*' || hour.startsWith('*/')) {
    const interval = hour === '*' ? 1 : parseInt(hour.slice(2))
    if (!isNaN(interval) && dayOfMonth === '*' && dayOfWeek === '*') {
      return {
        ...defaultState,
        frequency: 'hourly',
        hourlyInterval: interval,
        minute: minuteValue,
      }
    }
  }

  // Parse hour for other patterns
  const parsedHour = parseInt(hour)
  const hourValue = isNaN(parsedHour) ? 9 : parsedHour

  // Weekly pattern: "M H * * D" or "M H * * D,D,D"
  if (dayOfMonth === '*' && dayOfWeek !== '*' && !dayOfWeek.includes('-')) {
    const weekdayValues = dayOfWeek
      .split(',')
      .map(d => parseInt(d))
      .filter(d => !isNaN(d))
    if (weekdayValues.length > 0) {
      return {
        ...defaultState,
        frequency: 'weekly',
        hour: hourValue,
        minute: minuteValue,
        weekdays: weekdayValues,
      }
    }
  }

  // Weekly pattern with range: "M H * * 1-5"
  if (dayOfMonth === '*' && dayOfWeek.includes('-')) {
    const [start, end] = dayOfWeek.split('-').map(d => parseInt(d))
    if (!isNaN(start) && !isNaN(end)) {
      const weekdayValues: number[] = []
      for (let i = start; i <= end; i++) {
        weekdayValues.push(i)
      }
      return {
        ...defaultState,
        frequency: 'weekly',
        hour: hourValue,
        minute: minuteValue,
        weekdays: weekdayValues,
      }
    }
  }

  // Monthly pattern: "M H D * *"
  if (dayOfMonth !== '*' && dayOfWeek === '*') {
    const parsedDay = parseInt(dayOfMonth)
    if (!isNaN(parsedDay)) {
      return {
        ...defaultState,
        frequency: 'monthly',
        hour: hourValue,
        minute: minuteValue,
        monthDay: parsedDay,
      }
    }
  }

  // Daily pattern: "M H * * *"
  if (dayOfMonth === '*' && dayOfWeek === '*' && !hour.includes('*') && !hour.includes('/')) {
    return {
      ...defaultState,
      frequency: 'daily',
      hour: hourValue,
      minute: minuteValue,
    }
  }

  // Fallback to custom
  return { ...defaultState, frequency: 'custom', customExpression: expression }
}

/**
 * Generate cron expression from schedule state
 */
function generateCronExpression(state: ScheduleState): string {
  switch (state.frequency) {
    case 'hourly':
      if (state.hourlyInterval === 1) {
        return `${state.minute} * * * *`
      }
      return `${state.minute} */${state.hourlyInterval} * * *`

    case 'daily':
      return `${state.minute} ${state.hour} * * *`

    case 'weekly': {
      const weekdayStr = state.weekdays.sort((a, b) => a - b).join(',')
      return `${state.minute} ${state.hour} * * ${weekdayStr || '1'}`
    }

    case 'monthly':
      return `${state.minute} ${state.hour} ${state.monthDay} * *`

    case 'custom':
      return state.customExpression

    default:
      return '0 9 * * *'
  }
}

/**
 * Validate cron expression
 */
function isValidCronExpression(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression)
    return true
  } catch {
    return false
  }
}

/**
 * Calculate next N execution times
 */
function getNextExecutions(expression: string, timezone: string, count: number = 5): Date[] {
  try {
    const cronExpression = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(),
    })
    const runs: Date[] = []
    for (let i = 0; i < count; i++) {
      const next = cronExpression.next()
      if (next) {
        runs.push(next.toDate())
      }
    }
    return runs
  } catch {
    return []
  }
}

/**
 * Format date for preview display
 */
function formatExecutionDate(date: Date, t: (key: string) => string): string {
  const weekdayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const weekday = t(`weekday_short_${weekdayKeys[date.getDay()]}`)

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${year}-${month}-${day} (${weekday}) ${hours}:${minutes}`
}

export function CronSchedulePicker({
  value,
  onChange,
  className,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}: CronSchedulePickerProps) {
  const { t } = useTranslation('feed')
  const [schedule, setSchedule] = useState<ScheduleState>(() => parseCronExpression(value))
  const [showAllHours, setShowAllHours] = useState(false)
  const [showCustomMinute, setShowCustomMinute] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customExpressionError, setCustomExpressionError] = useState<string | null>(null)

  // Sync with external value changes
  useEffect(() => {
    const parsed = parseCronExpression(value)
    setSchedule(parsed)
  }, [value])

  // Update parent when schedule changes
  const updateSchedule = useCallback(
    (newSchedule: ScheduleState) => {
      setSchedule(newSchedule)
      const expression = generateCronExpression(newSchedule)
      if (isValidCronExpression(expression)) {
        setCustomExpressionError(null)
        onChange(expression)
      }
    },
    [onChange]
  )

  // Handle frequency change
  const handleFrequencyChange = useCallback(
    (frequency: string) => {
      if (!frequency) return
      const newSchedule: ScheduleState = {
        ...schedule,
        frequency: frequency as FrequencyType,
      }
      // Reset to defaults if switching to custom
      if (frequency === 'custom') {
        newSchedule.customExpression = generateCronExpression(schedule)
      }
      updateSchedule(newSchedule)
    },
    [schedule, updateSchedule]
  )

  // Handle weekday toggle
  const handleWeekdayToggle = useCallback(
    (weekday: number) => {
      const currentWeekdays = schedule.weekdays
      let newWeekdays: number[]

      if (currentWeekdays.includes(weekday)) {
        // Remove weekday, but keep at least one
        newWeekdays = currentWeekdays.filter(d => d !== weekday)
        if (newWeekdays.length === 0) {
          newWeekdays = [weekday]
        }
      } else {
        // Add weekday
        newWeekdays = [...currentWeekdays, weekday]
      }

      updateSchedule({ ...schedule, weekdays: newWeekdays })
    },
    [schedule, updateSchedule]
  )

  // Handle custom expression change
  const handleCustomExpressionChange = useCallback(
    (expression: string) => {
      setSchedule(prev => ({ ...prev, customExpression: expression }))

      if (isValidCronExpression(expression)) {
        setCustomExpressionError(null)
        onChange(expression)
      } else {
        setCustomExpressionError(t('cron_invalid_expression'))
      }
    },
    [onChange, t]
  )

  // Calculate next executions
  const nextExecutions = useMemo(() => {
    const expression = generateCronExpression(schedule)
    return getNextExecutions(expression, timezone, 5)
  }, [schedule, timezone])

  // Current cron expression
  const currentExpression = useMemo(() => generateCronExpression(schedule), [schedule])

  // Check if current minute is a common value
  const isCommonMinute = COMMON_MINUTES.includes(schedule.minute)

  return (
    <div className={cn('space-y-4', className)}>
      {/* Frequency Toggle Group */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">{t('schedule_frequency')}</Label>
        <ToggleGroup
          type="single"
          value={schedule.frequency}
          onValueChange={handleFrequencyChange}
          className="flex flex-wrap gap-2"
        >
          <ToggleGroupItem value="hourly" className="flex-1 min-w-[70px]">
            {t('frequency_hourly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="daily" className="flex-1 min-w-[70px]">
            {t('frequency_daily')}
          </ToggleGroupItem>
          <ToggleGroupItem value="weekly" className="flex-1 min-w-[70px]">
            {t('frequency_weekly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="monthly" className="flex-1 min-w-[70px]">
            {t('frequency_monthly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="custom" className="flex-1 min-w-[70px]">
            {t('frequency_custom')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Hourly Configuration */}
      {schedule.frequency === 'hourly' && (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('hourly_interval')}</Label>
            <div className="flex flex-wrap gap-2">
              {HOURLY_INTERVALS.map(interval => (
                <Toggle
                  key={interval}
                  pressed={schedule.hourlyInterval === interval}
                  onPressedChange={() => updateSchedule({ ...schedule, hourlyInterval: interval })}
                  className="min-w-[44px]"
                >
                  {interval}
                </Toggle>
              ))}
            </div>
            <p className="text-xs text-text-muted">
              {t('hourly_interval_hint', { interval: schedule.hourlyInterval })}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('at_minute_label')}</Label>
            <div className="flex flex-wrap gap-2">
              {COMMON_MINUTES.map(minute => (
                <Toggle
                  key={minute}
                  pressed={schedule.minute === minute}
                  onPressedChange={() => updateSchedule({ ...schedule, minute })}
                  className="min-w-[44px]"
                >
                  {String(minute).padStart(2, '0')}
                </Toggle>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Daily Configuration */}
      {schedule.frequency === 'daily' && (
        <div className="space-y-3">
          {/* Hour Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('execute_hour')}</Label>
            <div className="flex flex-wrap gap-2">
              {COMMON_HOURS.map(hour => (
                <Toggle
                  key={hour}
                  pressed={schedule.hour === hour}
                  onPressedChange={() => updateSchedule({ ...schedule, hour })}
                  className="min-w-[44px]"
                >
                  {String(hour).padStart(2, '0')}
                </Toggle>
              ))}
              <Toggle
                pressed={showAllHours}
                onPressedChange={setShowAllHours}
                className="min-w-[60px]"
              >
                {t('more_hours')}
              </Toggle>
            </div>
            {showAllHours && (
              <div className="flex flex-wrap gap-1 p-3 bg-surface rounded-md border border-border">
                {Array.from({ length: 24 }, (_, i) => i).map(hour => (
                  <Toggle
                    key={hour}
                    pressed={schedule.hour === hour}
                    onPressedChange={() => updateSchedule({ ...schedule, hour })}
                    size="sm"
                    className="w-10 h-8"
                  >
                    {String(hour).padStart(2, '0')}
                  </Toggle>
                ))}
              </div>
            )}
          </div>

          {/* Minute Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('execute_minute')}</Label>
            <div className="flex flex-wrap gap-2">
              {COMMON_MINUTES.map(minute => (
                <Toggle
                  key={minute}
                  pressed={schedule.minute === minute && !showCustomMinute}
                  onPressedChange={() => {
                    setShowCustomMinute(false)
                    updateSchedule({ ...schedule, minute })
                  }}
                  className="min-w-[44px]"
                >
                  {String(minute).padStart(2, '0')}
                </Toggle>
              ))}
              <Toggle
                pressed={showCustomMinute || !isCommonMinute}
                onPressedChange={() => setShowCustomMinute(true)}
                className="min-w-[70px]"
              >
                {t('custom_minute')}
              </Toggle>
            </div>
            {(showCustomMinute || !isCommonMinute) && (
              <Input
                type="number"
                min={0}
                max={59}
                value={schedule.minute}
                onChange={e => {
                  const val = parseInt(e.target.value)
                  if (!isNaN(val) && val >= 0 && val <= 59) {
                    updateSchedule({ ...schedule, minute: val })
                  }
                }}
                className="w-24"
                placeholder="0-59"
              />
            )}
          </div>
        </div>
      )}

      {/* Weekly Configuration */}
      {schedule.frequency === 'weekly' && (
        <div className="space-y-3">
          {/* Weekday Multi-Select */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('select_weekdays')}</Label>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map(day => (
                <Toggle
                  key={day.value}
                  pressed={schedule.weekdays.includes(day.value)}
                  onPressedChange={() => handleWeekdayToggle(day.value)}
                  variant="pill"
                  className="w-10 h-10 rounded-full"
                >
                  {t(`weekday_short_${day.key}`)}
                </Toggle>
              ))}
            </div>
          </div>

          {/* Time Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('execute_time')}</Label>
            <div className="flex items-center gap-2">
              <div className="flex flex-wrap gap-2">
                {COMMON_HOURS.map(hour => (
                  <Toggle
                    key={hour}
                    pressed={schedule.hour === hour}
                    onPressedChange={() => updateSchedule({ ...schedule, hour })}
                    size="sm"
                    className="min-w-[40px]"
                  >
                    {String(hour).padStart(2, '0')}
                  </Toggle>
                ))}
              </div>
              <span className="text-text-secondary">:</span>
              <div className="flex gap-1">
                {COMMON_MINUTES.map(minute => (
                  <Toggle
                    key={minute}
                    pressed={schedule.minute === minute}
                    onPressedChange={() => updateSchedule({ ...schedule, minute })}
                    size="sm"
                    className="min-w-[40px]"
                  >
                    {String(minute).padStart(2, '0')}
                  </Toggle>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Monthly Configuration */}
      {schedule.frequency === 'monthly' && (
        <div className="space-y-3">
          {/* Day of Month Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('month_day_select')}</Label>
            <div className="flex flex-wrap gap-2">
              {COMMON_MONTH_DAYS.map(day => (
                <Toggle
                  key={day}
                  pressed={schedule.monthDay === day}
                  onPressedChange={() => updateSchedule({ ...schedule, monthDay: day })}
                  className="min-w-[44px]"
                >
                  {day}
                </Toggle>
              ))}
              <Toggle
                pressed={schedule.monthDay === -1}
                onPressedChange={() => updateSchedule({ ...schedule, monthDay: -1 })}
                className="min-w-[80px]"
              >
                {t('last_day')}
              </Toggle>
            </div>
            {!COMMON_MONTH_DAYS.includes(schedule.monthDay) && schedule.monthDay !== -1 && (
              <Input
                type="number"
                min={1}
                max={31}
                value={schedule.monthDay}
                onChange={e => {
                  const val = parseInt(e.target.value)
                  if (!isNaN(val) && val >= 1 && val <= 31) {
                    updateSchedule({ ...schedule, monthDay: val })
                  }
                }}
                className="w-24"
                placeholder="1-31"
              />
            )}
          </div>

          {/* Time Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t('execute_time')}</Label>
            <div className="flex items-center gap-2">
              <div className="flex flex-wrap gap-2">
                {COMMON_HOURS.map(hour => (
                  <Toggle
                    key={hour}
                    pressed={schedule.hour === hour}
                    onPressedChange={() => updateSchedule({ ...schedule, hour })}
                    size="sm"
                    className="min-w-[40px]"
                  >
                    {String(hour).padStart(2, '0')}
                  </Toggle>
                ))}
              </div>
              <span className="text-text-secondary">:</span>
              <div className="flex gap-1">
                {COMMON_MINUTES.map(minute => (
                  <Toggle
                    key={minute}
                    pressed={schedule.minute === minute}
                    onPressedChange={() => updateSchedule({ ...schedule, minute })}
                    size="sm"
                    className="min-w-[40px]"
                  >
                    {String(minute).padStart(2, '0')}
                  </Toggle>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Custom Expression */}
      {schedule.frequency === 'custom' && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t('cron_expression')}</Label>
          <Input
            value={schedule.customExpression}
            onChange={e => handleCustomExpressionChange(e.target.value)}
            placeholder="0 9 * * *"
            className={cn(customExpressionError && 'border-error')}
          />
          {customExpressionError && <p className="text-xs text-error">{customExpressionError}</p>}
          <p className="text-xs text-text-muted">{t('cron_format_hint')}</p>
        </div>
      )}

      {/* Execution Preview */}
      {nextExecutions.length > 0 && (
        <div className="rounded-md bg-surface border border-border p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Calendar className="h-4 w-4" />
            {t('execution_preview')}
          </div>
          <ul className="space-y-1 text-sm text-text-secondary">
            {nextExecutions.map((date, index) => (
              <li key={index} className="flex items-center gap-2">
                <Clock className="h-3 w-3 text-text-muted" />
                <span className={index === 0 ? 'text-primary font-medium' : ''}>
                  {index === 0 && `${t('next_run')}: `}
                  {formatExecutionDate(date, t)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Advanced: Cron Expression Editor */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors">
          <ChevronRight
            className={cn('h-4 w-4 transition-transform', advancedOpen && 'rotate-90')}
          />
          {t('advanced_cron_editor')}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <div className="rounded-md bg-surface border border-border p-3 space-y-2">
            <div className="space-y-1">
              <Label className="text-xs text-text-muted">{t('cron_expression')}</Label>
              <Input
                value={currentExpression}
                onChange={e => {
                  const expression = e.target.value
                  if (isValidCronExpression(expression)) {
                    const parsed = parseCronExpression(expression)
                    setSchedule(parsed)
                    onChange(expression)
                  }
                }}
                className="font-mono text-sm"
                placeholder="0 9 * * *"
              />
            </div>
            <div className="text-xs text-text-muted space-y-1">
              <p>
                💡 {t('cron_format_label')}: {t('cron_format_parts')}
              </p>
              <p>{t('cron_example')}</p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
