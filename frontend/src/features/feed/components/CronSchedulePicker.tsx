'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Google Calendar style cron schedule picker component.
 * Provides toggle-based frequency selection, multi-select weekday picker,
 * quick time selection, execution preview, and advanced cron editing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Calendar } from 'lucide-react'
import CronParser from 'cron-parser'
import { useTranslation } from '@/hooks/useTranslation'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

interface CronSchedulePickerProps {
  value: string
  onChange: (expression: string) => void
  timezone?: string
  className?: string
}

type FrequencyType = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

interface ScheduleState {
  frequency: FrequencyType
  hour: number
  minute: number
  weekdays: number[]
  monthDay: number | 'last'
  hourlyInterval: number
  customExpression: string
}

// Common hour quick selections
const QUICK_HOURS = [6, 9, 12, 15, 18, 21]

// Common minute quick selections
const QUICK_MINUTES = [0, 15, 30, 45]

// Hourly interval options
const HOURLY_INTERVALS = [1, 2, 3, 4, 6, 8, 12]

// Common month day quick selections
const QUICK_MONTH_DAYS = [1, 5, 10, 15, 20, 25]

/**
 * Parse cron expression to schedule state
 */
function parseCronExpression(expression: string): ScheduleState {
  const defaultState: ScheduleState = {
    frequency: 'daily',
    hour: 9,
    minute: 0,
    weekdays: [],
    monthDay: 1,
    hourlyInterval: 2,
    customExpression: expression,
  }

  const parts = expression.split(' ')
  if (parts.length !== 5) {
    return { ...defaultState, frequency: 'custom' }
  }

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts

  // Parse minute
  const minuteNum = parseInt(minute)
  const parsedMinute = isNaN(minuteNum) ? 0 : minuteNum

  // Hourly pattern: "M */N * * *" or "M * * * *"
  if (hour === '*' || hour.startsWith('*/')) {
    const interval = hour === '*' ? 1 : parseInt(hour.slice(2))
    if (dayOfMonth === '*' && dayOfWeek === '*') {
      return {
        ...defaultState,
        frequency: 'hourly',
        minute: parsedMinute,
        hourlyInterval: isNaN(interval) ? 1 : interval,
        customExpression: expression,
      }
    }
  }

  // Parse hour (for non-hourly patterns)
  const hourNum = parseInt(hour)
  const parsedHour = isNaN(hourNum) ? 9 : hourNum

  // Weekly pattern: "M H * * D" where D can be single, range, or comma-separated
  if (dayOfMonth === '*' && dayOfWeek !== '*') {
    // Parse weekdays (can be comma-separated like "1,3,5" or range like "1-5")
    const weekdays: number[] = []

    if (dayOfWeek.includes(',')) {
      // Comma-separated: "1,3,5"
      dayOfWeek.split(',').forEach(d => {
        const num = parseInt(d.trim())
        if (!isNaN(num)) weekdays.push(num)
      })
    } else if (dayOfWeek.includes('-')) {
      // Range: "1-5"
      const [start, end] = dayOfWeek.split('-').map(d => parseInt(d.trim()))
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) {
          weekdays.push(i)
        }
      }
    } else {
      // Single day
      const num = parseInt(dayOfWeek)
      if (!isNaN(num)) weekdays.push(num)
    }

    if (weekdays.length > 0) {
      return {
        ...defaultState,
        frequency: 'weekly',
        hour: parsedHour,
        minute: parsedMinute,
        weekdays,
        customExpression: expression,
      }
    }
  }

  // Monthly pattern: "M H D * *" where D can be a number or 'L' for last day
  if (dayOfMonth !== '*' && dayOfWeek === '*') {
    const monthDay = dayOfMonth === 'L' ? 'last' : parseInt(dayOfMonth)
    return {
      ...defaultState,
      frequency: 'monthly',
      hour: parsedHour,
      minute: parsedMinute,
      monthDay: monthDay === 'last' || !isNaN(monthDay as number) ? monthDay : 1,
      customExpression: expression,
    }
  }

  // Daily pattern: "M H * * *"
  if (dayOfMonth === '*' && dayOfWeek === '*' && !hour.includes('*') && !hour.includes('/')) {
    return {
      ...defaultState,
      frequency: 'daily',
      hour: parsedHour,
      minute: parsedMinute,
      customExpression: expression,
    }
  }

  // Default to custom for unrecognized patterns
  return { ...defaultState, frequency: 'custom', customExpression: expression }
}

/**
 * Generate cron expression from schedule state
 */
function generateCronExpression(state: ScheduleState): string {
  switch (state.frequency) {
    case 'hourly':
      return `${state.minute} */${state.hourlyInterval} * * *`
    case 'daily':
      return `${state.minute} ${state.hour} * * *`
    case 'weekly': {
      const weekdayStr =
        state.weekdays.length > 0 ? state.weekdays.sort((a, b) => a - b).join(',') : '1'
      return `${state.minute} ${state.hour} * * ${weekdayStr}`
    }
    case 'monthly': {
      const monthDayStr = state.monthDay === 'last' ? 'L' : state.monthDay
      return `${state.minute} ${state.hour} ${monthDayStr} * *`
    }
    case 'custom':
      return state.customExpression
    default:
      return '0 9 * * *'
  }
}

/**
 * Calculate next N execution times from cron expression
 */
function getNextRuns(expression: string, timezone: string, count: number = 5): Date[] {
  try {
    const cronExpression = CronParser.parse(expression, { tz: timezone })
    const runs: Date[] = []
    for (let i = 0; i < count; i++) {
      runs.push(cronExpression.next().toDate())
    }
    return runs
  } catch {
    return []
  }
}

/**
 * Validate cron expression
 */
function isValidCronExpression(expression: string): boolean {
  try {
    CronParser.parse(expression)
    return true
  } catch {
    return false
  }
}

/**
 * Format date for display
 */
function formatExecutionDate(date: Date, t: (key: string) => string): string {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const isToday = date.toDateString() === now.toDateString()
  const isTomorrow = date.toDateString() === tomorrow.toDateString()

  const weekdayKeys = [
    'weekday_short_sun',
    'weekday_short_mon',
    'weekday_short_tue',
    'weekday_short_wed',
    'weekday_short_thu',
    'weekday_short_fri',
    'weekday_short_sat',
  ]
  const weekday = t(weekdayKeys[date.getDay()])

  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  if (isToday) {
    return `${t('today')} ${timeStr}`
  } else if (isTomorrow) {
    return `${t('tomorrow')} ${timeStr}`
  }

  return `${dateStr} (${weekday}) ${timeStr}`
}

export function CronSchedulePicker({
  value,
  onChange,
  timezone,
  className,
}: CronSchedulePickerProps) {
  const { t } = useTranslation('feed')
  const [schedule, setSchedule] = useState<ScheduleState>(() => parseCronExpression(value))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [showAllHours, setShowAllHours] = useState(false)
  const [customMinute, setCustomMinute] = useState<string>('')
  const [showCustomMinute, setShowCustomMinute] = useState(false)

  // Get user's timezone if not provided
  const effectiveTimezone = useMemo(() => {
    if (timezone) return timezone
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return 'UTC'
    }
  }, [timezone])

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
      onChange(expression)
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
        customExpression: generateCronExpression({
          ...schedule,
          frequency: frequency as FrequencyType,
        }),
      }
      updateSchedule(newSchedule)
    },
    [schedule, updateSchedule]
  )

  // Handle weekday toggle
  const handleWeekdayToggle = useCallback(
    (day: number) => {
      const newWeekdays = schedule.weekdays.includes(day)
        ? schedule.weekdays.filter(d => d !== day)
        : [...schedule.weekdays, day]
      updateSchedule({ ...schedule, weekdays: newWeekdays })
    },
    [schedule, updateSchedule]
  )

  // Handle hour selection
  const handleHourChange = useCallback(
    (hour: number) => {
      updateSchedule({ ...schedule, hour })
    },
    [schedule, updateSchedule]
  )

  // Handle minute selection
  const handleMinuteChange = useCallback(
    (minute: number) => {
      updateSchedule({ ...schedule, minute })
      setShowCustomMinute(false)
    },
    [schedule, updateSchedule]
  )

  // Handle custom minute input
  const handleCustomMinuteSubmit = useCallback(() => {
    const minute = parseInt(customMinute)
    if (!isNaN(minute) && minute >= 0 && minute <= 59) {
      updateSchedule({ ...schedule, minute })
      setShowCustomMinute(false)
      setCustomMinute('')
    }
  }, [customMinute, schedule, updateSchedule])

  // Handle hourly interval change
  const handleHourlyIntervalChange = useCallback(
    (interval: string) => {
      if (!interval) return
      updateSchedule({ ...schedule, hourlyInterval: parseInt(interval) })
    },
    [schedule, updateSchedule]
  )

  // Handle month day change
  const handleMonthDayChange = useCallback(
    (day: number | 'last') => {
      updateSchedule({ ...schedule, monthDay: day })
    },
    [schedule, updateSchedule]
  )

  // Handle custom expression change
  const handleCustomExpressionChange = useCallback(
    (expression: string) => {
      const newSchedule = { ...schedule, customExpression: expression }
      setSchedule(newSchedule)

      // Only update parent if expression is valid
      if (isValidCronExpression(expression)) {
        onChange(expression)
        // Try to parse and update UI if it matches a known pattern
        const parsed = parseCronExpression(expression)
        if (parsed.frequency !== 'custom') {
          setSchedule({ ...parsed, customExpression: expression })
        }
      }
    },
    [schedule, onChange]
  )

  // Calculate next execution times
  const nextRuns = useMemo(() => {
    const expression =
      schedule.frequency === 'custom' ? schedule.customExpression : generateCronExpression(schedule)
    return getNextRuns(expression, effectiveTimezone, 5)
  }, [schedule, effectiveTimezone])

  // Check if custom expression is valid
  const isCustomValid = useMemo(() => {
    return schedule.frequency !== 'custom' || isValidCronExpression(schedule.customExpression)
  }, [schedule])

  // Weekday options
  const weekdayOptions = [
    { value: 1, key: 'weekday_short_mon' },
    { value: 2, key: 'weekday_short_tue' },
    { value: 3, key: 'weekday_short_wed' },
    { value: 4, key: 'weekday_short_thu' },
    { value: 5, key: 'weekday_short_fri' },
    { value: 6, key: 'weekday_short_sat' },
    { value: 0, key: 'weekday_short_sun' },
  ]

  // All hours for expanded view
  const allHours = Array.from({ length: 24 }, (_, i) => i)

  // Current cron expression
  const currentExpression =
    schedule.frequency === 'custom' ? schedule.customExpression : generateCronExpression(schedule)

  return (
    <div className={cn('space-y-4', className)}>
      {/* Frequency Toggle Group */}
      <div>
        <Label className="text-sm font-medium mb-2 block">{t('schedule_frequency')}</Label>
        <ToggleGroup
          type="single"
          value={schedule.frequency}
          onValueChange={handleFrequencyChange}
          variant="outline"
          className="justify-start flex-wrap gap-2"
        >
          <ToggleGroupItem value="hourly" className="px-4">
            {t('frequency_hourly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="daily" className="px-4">
            {t('frequency_daily')}
          </ToggleGroupItem>
          <ToggleGroupItem value="weekly" className="px-4">
            {t('frequency_weekly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="monthly" className="px-4">
            {t('frequency_monthly')}
          </ToggleGroupItem>
          <ToggleGroupItem value="custom" className="px-4">
            {t('frequency_custom')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Hourly Configuration */}
      {schedule.frequency === 'hourly' && (
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium mb-2 block">{t('hourly_interval_label')}</Label>
            <ToggleGroup
              type="single"
              value={String(schedule.hourlyInterval)}
              onValueChange={handleHourlyIntervalChange}
              variant="outline"
              className="justify-start flex-wrap gap-2"
            >
              {HOURLY_INTERVALS.map(interval => (
                <ToggleGroupItem key={interval} value={String(interval)} className="px-3">
                  {interval}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-text-muted mt-1">{t('hourly_interval_unit')}</p>
          </div>
          <div>
            <Label className="text-sm font-medium mb-2 block">{t('at_minute_label')}</Label>
            <div className="flex flex-wrap gap-2 items-center">
              {QUICK_MINUTES.map(minute => (
                <button
                  key={minute}
                  type="button"
                  onClick={() => handleMinuteChange(minute)}
                  className={cn(
                    'h-9 px-3 rounded-md text-sm font-medium transition-colors',
                    schedule.minute === minute
                      ? 'bg-primary text-white'
                      : 'bg-surface border border-border hover:bg-primary/10'
                  )}
                >
                  {String(minute).padStart(2, '0')}
                </button>
              ))}
              {!showCustomMinute ? (
                <button
                  type="button"
                  onClick={() => setShowCustomMinute(true)}
                  className="h-9 px-3 rounded-md text-sm font-medium bg-surface border border-border hover:bg-primary/10"
                >
                  {t('custom_minute')}...
                </button>
              ) : (
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    value={customMinute}
                    onChange={e => setCustomMinute(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCustomMinuteSubmit()}
                    className="w-16 h-9"
                    placeholder="0-59"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={handleCustomMinuteSubmit}
                    className="h-9 px-2 rounded-md text-sm font-medium bg-primary text-white"
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Weekly Configuration - Weekday Selector */}
      {schedule.frequency === 'weekly' && (
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium mb-2 block">{t('weekday_label')}</Label>
            <div className="flex flex-wrap gap-2">
              {weekdayOptions.map(day => (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => handleWeekdayToggle(day.value)}
                  className={cn(
                    'h-10 w-10 rounded-full text-sm font-medium transition-colors',
                    schedule.weekdays.includes(day.value)
                      ? 'bg-primary text-white'
                      : 'bg-surface border border-border hover:bg-primary/10'
                  )}
                >
                  {t(day.key)}
                </button>
              ))}
            </div>
            {schedule.weekdays.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">{t('weekday_required_hint')}</p>
            )}
          </div>
        </div>
      )}

      {/* Monthly Configuration - Day Selector */}
      {schedule.frequency === 'monthly' && (
        <div>
          <Label className="text-sm font-medium mb-2 block">{t('month_day_label')}</Label>
          <div className="flex flex-wrap gap-2">
            {QUICK_MONTH_DAYS.map(day => (
              <button
                key={day}
                type="button"
                onClick={() => handleMonthDayChange(day)}
                className={cn(
                  'h-9 px-3 rounded-md text-sm font-medium transition-colors',
                  schedule.monthDay === day
                    ? 'bg-primary text-white'
                    : 'bg-surface border border-border hover:bg-primary/10'
                )}
              >
                {day}
              </button>
            ))}
            <button
              type="button"
              onClick={() => handleMonthDayChange('last')}
              className={cn(
                'h-9 px-3 rounded-md text-sm font-medium transition-colors',
                schedule.monthDay === 'last'
                  ? 'bg-primary text-white'
                  : 'bg-surface border border-border hover:bg-primary/10'
              )}
            >
              {t('last_day')}
            </button>
          </div>
        </div>
      )}

      {/* Time Selection for Daily/Weekly/Monthly */}
      {(schedule.frequency === 'daily' ||
        schedule.frequency === 'weekly' ||
        schedule.frequency === 'monthly') && (
        <div className="space-y-3">
          {/* Hour Selection */}
          <div>
            <Label className="text-sm font-medium mb-2 block">{t('hour_label')}</Label>
            <div className="flex flex-wrap gap-2 items-center">
              {(showAllHours ? allHours : QUICK_HOURS).map(hour => (
                <button
                  key={hour}
                  type="button"
                  onClick={() => handleHourChange(hour)}
                  className={cn(
                    'h-9 px-3 rounded-md text-sm font-medium transition-colors',
                    schedule.hour === hour
                      ? 'bg-primary text-white'
                      : 'bg-surface border border-border hover:bg-primary/10'
                  )}
                >
                  {String(hour).padStart(2, '0')}
                </button>
              ))}
              {!showAllHours && (
                <button
                  type="button"
                  onClick={() => setShowAllHours(true)}
                  className="h-9 px-3 rounded-md text-sm font-medium bg-surface border border-border hover:bg-primary/10 flex items-center gap-1"
                >
                  {t('more_hours')}
                  <ChevronDown className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Minute Selection */}
          <div>
            <Label className="text-sm font-medium mb-2 block">{t('minute_label')}</Label>
            <div className="flex flex-wrap gap-2 items-center">
              {QUICK_MINUTES.map(minute => (
                <button
                  key={minute}
                  type="button"
                  onClick={() => handleMinuteChange(minute)}
                  className={cn(
                    'h-9 px-3 rounded-md text-sm font-medium transition-colors',
                    schedule.minute === minute
                      ? 'bg-primary text-white'
                      : 'bg-surface border border-border hover:bg-primary/10'
                  )}
                >
                  {String(minute).padStart(2, '0')}
                </button>
              ))}
              {!showCustomMinute ? (
                <button
                  type="button"
                  onClick={() => setShowCustomMinute(true)}
                  className="h-9 px-3 rounded-md text-sm font-medium bg-surface border border-border hover:bg-primary/10"
                >
                  {t('custom_minute')}...
                </button>
              ) : (
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    value={customMinute}
                    onChange={e => setCustomMinute(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCustomMinuteSubmit()}
                    className="w-16 h-9"
                    placeholder="0-59"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={handleCustomMinuteSubmit}
                    className="h-9 px-2 rounded-md text-sm font-medium bg-primary text-white"
                  >
                    OK
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Custom Expression Input */}
      {schedule.frequency === 'custom' && (
        <div>
          <Label className="text-sm font-medium mb-2 block">{t('cron_expression')}</Label>
          <Input
            value={schedule.customExpression}
            onChange={e => handleCustomExpressionChange(e.target.value)}
            placeholder="0 9 * * 1-5"
            className={cn(!isCustomValid && 'border-destructive focus-visible:ring-destructive')}
          />
          <p className="text-xs text-text-muted mt-1">{t('cron_format_hint')}</p>
          {!isCustomValid && (
            <p className="text-xs text-destructive mt-1">{t('cron_invalid_hint')}</p>
          )}
        </div>
      )}

      {/* Execution Preview */}
      {nextRuns.length > 0 && (
        <div className="rounded-lg border border-border bg-surface/50 p-4">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{t('execution_preview')}</span>
          </div>
          <ul className="space-y-1.5">
            {nextRuns.map((run, index) => (
              <li key={index} className="text-sm text-text-secondary flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/60"></span>
                {index === 0 && <span className="text-primary font-medium">{t('next_run')}:</span>}
                {formatExecutionDate(run, t)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Advanced Mode - Collapsible Cron Expression Editor */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary transition-colors">
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          {t('advanced_cron_edit')}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3">
          <div className="rounded-lg border border-border bg-surface/30 p-4 space-y-3">
            <div>
              <Label className="text-sm font-medium mb-2 block">{t('cron_expression')}</Label>
              <Input
                value={currentExpression}
                onChange={e => {
                  const expression = e.target.value
                  // Update customExpression and try to parse
                  const parsed = parseCronExpression(expression)
                  setSchedule({ ...parsed, customExpression: expression })
                  if (isValidCronExpression(expression)) {
                    onChange(expression)
                  }
                }}
                className={cn(
                  'font-mono',
                  !isValidCronExpression(currentExpression) &&
                    'border-destructive focus-visible:ring-destructive'
                )}
              />
            </div>
            <div className="text-xs text-text-muted space-y-1">
              <p>
                💡 {t('cron_format_label')}: {t('cron_format_fields')}
              </p>
              <p>
                {t('cron_example_label')}: <code className="bg-base px-1 rounded">0 9 * * 1-5</code>{' '}
                = {t('cron_example_weekdays_9am')}
              </p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
