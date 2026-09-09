import type { AutomationUiTrigger } from './automationRuleBackend'

export function parseCron(expression: string | null) {
  const parts = (expression ?? '0 3 * * *').trim().split(/\s+/)
  const minute = Number(parts[0] ?? 0)
  const hour = Number(parts[1] ?? 3)
  const dayOfWeek = parts[4] ?? '*'
  const time = `${String(Number.isFinite(hour) ? hour : 3).padStart(2, '0')}:${String(
    Number.isFinite(minute) ? minute : 0
  ).padStart(2, '0')}`
  if (parts[1] === '*' && parts.slice(2).every(part => part === '*')) {
    return {
      frequency: 'hourly' as const,
      weekday: 'monday',
      time: `00:${String(minute).padStart(2, '0')}`,
    }
  }
  if (dayOfWeek === '1-5') {
    return { frequency: 'weekdays' as const, weekday: 'monday', time }
  }
  if (/^[0-6]$/.test(dayOfWeek)) {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    return { frequency: 'weekly' as const, weekday: weekdays[Number(dayOfWeek)], time }
  }
  return { frequency: 'daily' as const, weekday: 'monday', time }
}

export function buildCron(trigger: AutomationUiTrigger): string {
  const [hourText, minuteText] = trigger.schedule.time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (trigger.schedule.frequency === 'hourly') return `${minute} * * * *`
  const prefix = `${Number.isFinite(minute) ? minute : 0} ${Number.isFinite(hour) ? hour : 3}`
  if (trigger.schedule.frequency === 'weekdays') return `${prefix} * * 1-5`
  if (trigger.schedule.frequency === 'weekly') {
    const weekday = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    }[trigger.schedule.weekday]
    return `${prefix} * * ${weekday ?? 1}`
  }
  return `${prefix} * * *`
}
