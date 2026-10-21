import type { SiteAnalyticsRange } from '@/api/sites'

export function analyticsToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

export function recentAnalyticsRange(days: number, today = analyticsToday()): SiteAnalyticsRange {
  const end = Date.parse(`${today}T00:00:00Z`)
  return {
    start_date: new Date(end - (days - 1) * 86_400_000).toISOString().slice(0, 10),
    end_date: today,
  }
}

export function validAnalyticsRange(range: SiteAnalyticsRange, today = analyticsToday()): boolean {
  const dates = [range.start_date, range.end_date]
  if (!dates.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value))) return false
  const times = dates.map(value => Date.parse(`${value}T00:00:00Z`))
  if (
    !times.every(
      (time, i) =>
        !dates[i].startsWith('0000-') &&
        Number.isFinite(time) &&
        new Date(time).toISOString().slice(0, 10) === dates[i]
    )
  )
    return false
  const days = (times[1] - times[0]) / 86_400_000 + 1
  return days >= 1 && days <= 31 && range.end_date <= today
}
