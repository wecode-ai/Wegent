import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import { getLocalCodexAuthStatus } from './runtimeAuthStatus'

export interface CodexRateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface CodexRateLimitSnapshot {
  limitId: string | null
  limitName: string | null
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
}

export interface CodexRateLimitsResponse {
  rateLimits: CodexRateLimitSnapshot
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot | undefined> | null
}

export interface CodexUsageWindowDisplay {
  label: '5h' | '7d'
  title: string
  value: string
  percent: number | null
  resetsAt: number | null
}

export interface CodexUsageDisplay {
  status: 'available' | 'none'
  fiveHour: CodexUsageWindowDisplay
  sevenDay: CodexUsageWindowDisplay
  trayTitle: string
  tooltip: string
}

const EMPTY_VALUE = '无'
const FIVE_HOUR_MINUTES = 5 * 60
const SEVEN_DAY_MINUTES = 7 * 24 * 60
const MILLISECONDS_PER_SECOND = 1000

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function remainingPercent(window: CodexRateLimitWindow | null | undefined): number | null {
  if (!window || typeof window.usedPercent !== 'number') return null
  return clampPercent(100 - window.usedPercent)
}

function emptyWindow(label: '5h' | '7d'): CodexUsageWindowDisplay {
  return {
    label,
    title: label === '5h' ? '5小时额度' : '7天额度',
    value: EMPTY_VALUE,
    percent: null,
    resetsAt: null,
  }
}

function formatWindow(
  label: '5h' | '7d',
  window: CodexRateLimitWindow | null | undefined
): CodexUsageWindowDisplay {
  const percent = remainingPercent(window)
  if (percent === null) {
    return emptyWindow(label)
  }
  return {
    label,
    title: label === '5h' ? '5小时额度' : '7天额度',
    value: `${percent}%`,
    percent,
    resetsAt: window?.resetsAt ?? null,
  }
}

function windowsFromSnapshot(snapshot: CodexRateLimitSnapshot | null | undefined) {
  const windows = [snapshot?.primary, snapshot?.secondary].filter(Boolean) as CodexRateLimitWindow[]
  return {
    fiveHour: windows.find(window => window.windowDurationMins === FIVE_HOUR_MINUTES) ?? null,
    sevenDay: windows.find(window => window.windowDurationMins === SEVEN_DAY_MINUTES) ?? null,
  }
}

function isEnglishLocale(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return navigator.language.toLowerCase().startsWith('en')
}

function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function formatCodexUsageResetTime(
  resetsAt: number | null,
  now = new Date()
): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) {
    return null
  }

  const resetDate = new Date(resetsAt * MILLISECONDS_PER_SECOND)
  if (Number.isNaN(resetDate.getTime())) {
    return null
  }

  const english = isEnglishLocale()
  if (english) {
    const time = resetDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })
    if (isSameLocalDate(resetDate, now)) {
      return time
    }
    const date = resetDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
    return `${date}, ${time}`
  }

  const time = resetDate.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  if (isSameLocalDate(resetDate, now)) {
    return time
  }
  return `${resetDate.getMonth() + 1}月${resetDate.getDate()}日 ${time}`
}

function formatTooltipLine(window: CodexUsageWindowDisplay): string {
  const resetTime = formatCodexUsageResetTime(window.resetsAt)
  const resetText = resetTime
    ? isEnglishLocale()
      ? ` (resets ${resetTime})`
      : `（${resetTime} 重置）`
    : ''
  return `${window.title} ${window.value}${resetText}`
}

function codexSnapshot(response: CodexRateLimitsResponse): CodexRateLimitSnapshot | null {
  return response.rateLimitsByLimitId?.codex ?? response.rateLimits ?? null
}

export function formatCodexUsageDisplay(
  response: CodexRateLimitsResponse | null | undefined
): CodexUsageDisplay {
  const snapshot = response ? codexSnapshot(response) : null
  const windows = windowsFromSnapshot(snapshot)
  const fiveHour = formatWindow('5h', windows.fiveHour)
  const sevenDay = formatWindow('7d', windows.sevenDay)
  const status = fiveHour.percent === null && sevenDay.percent === null ? 'none' : 'available'
  const trayFiveHourValue = fiveHour.percent === null ? '--' : fiveHour.value
  const traySevenDayValue = sevenDay.percent === null ? '--' : sevenDay.value
  const trayTitle = `5h ${trayFiveHourValue}\n7d ${traySevenDayValue}`
  return {
    status,
    fiveHour,
    sevenDay,
    trayTitle,
    tooltip: `${isEnglishLocale() ? 'Codex quota' : 'Codex 额度'}\n${formatTooltipLine(fiveHour)}\n${formatTooltipLine(sevenDay)}`,
  }
}

export function emptyCodexUsageDisplay(): CodexUsageDisplay {
  return formatCodexUsageDisplay(null)
}

export async function getLocalCodexUsageDisplay(): Promise<CodexUsageDisplay> {
  const authStatus = await getLocalCodexAuthStatus()
  if (!authStatus.exists) {
    return emptyCodexUsageDisplay()
  }

  await ensureLocalExecutorStarted()
  const response = await requestLocalExecutor<CodexRateLimitsResponse>(
    'runtime.codex.rate_limits.read'
  )
  return formatCodexUsageDisplay(response)
}
