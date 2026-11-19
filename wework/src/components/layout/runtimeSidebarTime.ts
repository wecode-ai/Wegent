import { useClock } from '@wegent/collaboration/clock'

const SIDEBAR_TIME_REFRESH_INTERVAL_MS = 60_000

export function formatRelativeSidebarTime(value?: string | number, nowMs = Date.now()) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const elapsedMs = Math.max(0, nowMs - date.getTime())
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  return `${Math.floor(days / 7)}w`
}

export function useSidebarRelativeTimeRefresh(enabled = true) {
  return useClock(enabled, { resolutionMs: SIDEBAR_TIME_REFRESH_INTERVAL_MS })
}
