import { useEffect, useState } from 'react'

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

export function useSidebarRelativeTimeRefresh() {
  const [, setRefreshTick] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRefreshTick(tick => tick + 1)
    }, SIDEBAR_TIME_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(timer)
  }, [])
}
