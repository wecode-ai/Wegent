'use client'

// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * User-friendly cron schedule picker component.
 * Provides preset options and visual time selection instead of raw cron expression input.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface CronSchedulePickerProps {
  value: string
  onChange: (expression: string) => void
  className?: string
}

type ScheduleType = 'preset' | 'daily' | 'weekly' | 'monthly' | 'hourly'

interface ScheduleState {
  type: ScheduleType
  preset?: string
  hour?: number
  minute?: number
  weekday?: number
  monthDay?: number
  hourlyInterval?: number
}

// Preset cron expressions with their display keys
const PRESETS = [
  { key: 'every_hour', expression: '0 * * * *' },
  { key: 'every_2_hours', expression: '0 */2 * * *' },
  { key: 'every_6_hours', expression: '0 */6 * * *' },
  { key: 'every_12_hours', expression: '0 */12 * * *' },
  { key: 'daily_9am', expression: '0 9 * * *' },
  { key: 'daily_noon', expression: '0 12 * * *' },
  { key: 'daily_6pm', expression: '0 18 * * *' },
  { key: 'weekdays_9am', expression: '0 9 * * 1-5' },
  { key: 'weekly_monday_9am', expression: '0 9 * * 1' },
  { key: 'monthly_1st_9am', expression: '0 9 1 * *' },
]

// Parse cron expression to schedule state
// The cron expression represents time in the user's configured timezone (from trigger_config.timezone).
// Backend handles timezone conversion to UTC, so we parse the expression as-is without conversion.
function parseCronExpression(expression: string): ScheduleState {
  // Check if it matches a preset
  const preset = PRESETS.find(p => p.expression === expression)
  if (preset) {
    return { type: 'preset', preset: preset.key }
  }

  const parts = expression.split(' ')
  if (parts.length !== 5) {
    return { type: 'preset', preset: 'daily_9am' }
  }

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts

  // Hourly pattern: "0 */N * * *" or "M */N * * *"
  if (hour.startsWith('*/') && dayOfMonth === '*' && dayOfWeek === '*') {
    const interval = parseInt(hour.slice(2))
    if (!isNaN(interval)) {
      return {
        type: 'hourly',
        hourlyInterval: interval,
        minute: parseInt(minute) || 0,
      }
    }
  }

  // Daily pattern: "M H * * *"
  if (dayOfMonth === '*' && dayOfWeek === '*' && !hour.includes('*') && !hour.includes('/')) {
    return {
      type: 'daily',
      hour: parseInt(hour) || 9,
      minute: parseInt(minute) || 0,
    }
  }

  // Weekly pattern: "M H * * D"
  if (dayOfMonth === '*' && dayOfWeek !== '*' && !dayOfWeek.includes('-')) {
    return {
      type: 'weekly',
      hour: parseInt(hour) || 9,
      minute: parseInt(minute) || 0,
      weekday: parseInt(dayOfWeek) || 1,
    }
  }

  // Monthly pattern: "M H D * *"
  if (dayOfMonth !== '*' && dayOfWeek === '*') {
    return {
      type: 'monthly',
      hour: parseInt(hour) || 9,
      minute: parseInt(minute) || 0,
      monthDay: parseInt(dayOfMonth) || 1,
    }
  }

  // Default to preset
  return { type: 'preset', preset: 'daily_9am' }
}

// Generate cron expression from schedule state
// The cron expression represents time in the user's configured timezone.
// Backend will convert this to UTC based on trigger_config.timezone.
function generateCronExpression(state: ScheduleState): string {
  switch (state.type) {
    case 'preset': {
      const preset = PRESETS.find(p => p.key === state.preset)
      return preset?.expression || '0 9 * * *'
    }
    case 'hourly':
      return `${state.minute || 0} */${state.hourlyInterval || 1} * * *`
    case 'daily':
      return `${state.minute || 0} ${state.hour || 9} * * *`
    case 'weekly':
      return `${state.minute || 0} ${state.hour || 9} * * ${state.weekday || 1}`
    case 'monthly':
      return `${state.minute || 0} ${state.hour || 9} ${state.monthDay || 1} * *`
    default:
      return '0 9 * * *'
  }
}

export function CronSchedulePicker({ value, onChange, className }: CronSchedulePickerProps) {
  const { t } = useTranslation('flow')
  const [schedule, setSchedule] = useState<ScheduleState>(() => parseCronExpression(value))

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

  const handleTypeChange = useCallback(
    (type: ScheduleType) => {
      const newSchedule: ScheduleState = {
        type,
        hour: schedule.hour || 9,
        minute: schedule.minute || 0,
        weekday: schedule.weekday || 1,
        monthDay: schedule.monthDay || 1,
        hourlyInterval: schedule.hourlyInterval || 2,
        preset: type === 'preset' ? 'daily_9am' : undefined,
      }
      updateSchedule(newSchedule)
    },
    [schedule, updateSchedule]
  )

  // Generate hour options (0-23)
  const hourOptions = Array.from({ length: 24 }, (_, i) => i)

  // Generate minute options (0, 15, 30, 45)
  const minuteOptions = [0, 15, 30, 45]

  // Generate weekday options
  const weekdayOptions = [
    { value: 1, key: 'monday' },
    { value: 2, key: 'tuesday' },
    { value: 3, key: 'wednesday' },
    { value: 4, key: 'thursday' },
    { value: 5, key: 'friday' },
    { value: 6, key: 'saturday' },
    { value: 0, key: 'sunday' },
  ]

  // Generate month day options (1-31)
  const monthDayOptions = Array.from({ length: 31 }, (_, i) => i + 1)

  // Generate hourly interval options
  const hourlyIntervalOptions = [1, 2, 3, 4, 6, 8, 12]

  return (
    <div className={cn('space-y-4', className)}>
      {/* Schedule Type Selection */}
      <div>
        <Label className="text-sm font-medium">{t('schedule_type')}</Label>
        <Select value={schedule.type} onValueChange={handleTypeChange}>
          <SelectTrigger className="mt-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="preset">{t('schedule_preset')}</SelectItem>
            <SelectItem value="hourly">{t('schedule_hourly')}</SelectItem>
            <SelectItem value="daily">{t('schedule_daily')}</SelectItem>
            <SelectItem value="weekly">{t('schedule_weekly')}</SelectItem>
            <SelectItem value="monthly">{t('schedule_monthly')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Preset Selection */}
      {schedule.type === 'preset' && (
        <div>
          <Label className="text-sm font-medium">{t('schedule_preset_select')}</Label>
          <Select
            value={schedule.preset || 'daily_9am'}
            onValueChange={preset => updateSchedule({ ...schedule, preset })}
          >
            <SelectTrigger className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map(preset => (
                <SelectItem key={preset.key} value={preset.key}>
                  {t(`preset_${preset.key}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Hourly Configuration */}
      {schedule.type === 'hourly' && (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Label className="text-sm font-medium">{t('every')}</Label>
            <Select
              value={String(schedule.hourlyInterval || 2)}
              onValueChange={v => updateSchedule({ ...schedule, hourlyInterval: parseInt(v) })}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {hourlyIntervalOptions.map(interval => (
                  <SelectItem key={interval} value={String(interval)}>
                    {interval} {t('unit_hours')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <Label className="text-sm font-medium">{t('at_minute')}</Label>
            <Select
              value={String(schedule.minute || 0)}
              onValueChange={v => updateSchedule({ ...schedule, minute: parseInt(v) })}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {minuteOptions.map(minute => (
                  <SelectItem key={minute} value={String(minute)}>
                    {String(minute).padStart(2, '0')} {t('minute_suffix')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Daily Configuration */}
      {schedule.type === 'daily' && (
        <div>
          <Label className="text-sm font-medium">{t('execute_time')}</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <Select
              value={String(schedule.hour || 9)}
              onValueChange={v => updateSchedule({ ...schedule, hour: parseInt(v) })}
            >
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {hourOptions.map(hour => (
                  <SelectItem key={hour} value={String(hour)}>
                    {String(hour).padStart(2, '0')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-text-secondary">:</span>
            <Select
              value={String(schedule.minute || 0)}
              onValueChange={v => updateSchedule({ ...schedule, minute: parseInt(v) })}
            >
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {minuteOptions.map(minute => (
                  <SelectItem key={minute} value={String(minute)}>
                    {String(minute).padStart(2, '0')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Weekly Configuration */}
      {schedule.type === 'weekly' && (
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium">{t('weekday')}</Label>
            <Select
              value={String(schedule.weekday ?? 1)}
              onValueChange={v => updateSchedule({ ...schedule, weekday: parseInt(v) })}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {weekdayOptions.map(day => (
                  <SelectItem key={day.value} value={String(day.value)}>
                    {t(`weekday_${day.key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-sm font-medium">{t('execute_time')}</Label>
            <div className="mt-1.5 flex items-center gap-2">
              <Select
                value={String(schedule.hour || 9)}
                onValueChange={v => updateSchedule({ ...schedule, hour: parseInt(v) })}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hourOptions.map(hour => (
                    <SelectItem key={hour} value={String(hour)}>
                      {String(hour).padStart(2, '0')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-text-secondary">:</span>
              <Select
                value={String(schedule.minute || 0)}
                onValueChange={v => updateSchedule({ ...schedule, minute: parseInt(v) })}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {minuteOptions.map(minute => (
                    <SelectItem key={minute} value={String(minute)}>
                      {String(minute).padStart(2, '0')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* Monthly Configuration */}
      {schedule.type === 'monthly' && (
        <div className="space-y-3">
          <div>
            <Label className="text-sm font-medium">{t('month_day')}</Label>
            <Select
              value={String(schedule.monthDay || 1)}
              onValueChange={v => updateSchedule({ ...schedule, monthDay: parseInt(v) })}
            >
              <SelectTrigger className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthDayOptions.map(day => (
                  <SelectItem key={day} value={String(day)}>
                    {t('day_of_month', { day })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-sm font-medium">{t('execute_time')}</Label>
            <div className="mt-1.5 flex items-center gap-2">
              <Select
                value={String(schedule.hour || 9)}
                onValueChange={v => updateSchedule({ ...schedule, hour: parseInt(v) })}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hourOptions.map(hour => (
                    <SelectItem key={hour} value={String(hour)}>
                      {String(hour).padStart(2, '0')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-text-secondary">:</span>
              <Select
                value={String(schedule.minute || 0)}
                onValueChange={v => updateSchedule({ ...schedule, minute: parseInt(v) })}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {minuteOptions.map(minute => (
                    <SelectItem key={minute} value={String(minute)}>
                      {String(minute).padStart(2, '0')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* Preview */}
      <div className="rounded-md bg-surface p-3">
        <p className="text-xs text-text-muted">
          {t('cron_preview')}: <code className="font-mono">{value}</code>
        </p>
      </div>
    </div>
  )
}
