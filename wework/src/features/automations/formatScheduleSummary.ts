import type { AutomationSchedule } from '@/types/automation'
import type { useTranslation } from '@/hooks/useTranslation'

export function formatScheduleSummary(
  schedule: AutomationSchedule,
  locale: string,
  t: ReturnType<typeof useTranslation>['t'],
  timezone: string
): string {
  if (schedule.type === 'interval') {
    return locale.startsWith('zh')
      ? `每 ${schedule.value} ${schedule.unit === 'minutes' ? '分钟' : schedule.unit === 'hours' ? '小时' : '天'}`
      : `Every ${schedule.value} ${schedule.unit}`
  }
  if (schedule.type === 'one_time') {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(schedule.executeAt))
  }
  const parts = schedule.expression.trim().split(/\s+/)
  if (
    parts.length === 5 &&
    /^\d+$/.test(parts[0]) &&
    /^\d+$/.test(parts[1]) &&
    parts[2] === '*' &&
    parts[3] === '*'
  ) {
    const time = `${String(Number(parts[1])).padStart(2, '0')}:${String(Number(parts[0])).padStart(2, '0')}`
    if (parts[4] === '1-5') return locale.startsWith('zh') ? `工作日 ${time}` : `Weekdays ${time}`
    if (parts[4] === '*') return locale.startsWith('zh') ? `每天 ${time}` : `Daily ${time}`
    if (/^[0-7]$/.test(parts[4])) {
      const day = new Intl.DateTimeFormat(locale, {
        weekday: locale.startsWith('zh') ? 'short' : 'long',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(2023, 0, 1 + (Number(parts[4]) % 7))))
      return t('todo.automation_weekly_at', { day, time })
    }
  }
  return t('todo.automation_custom_schedule')
}
