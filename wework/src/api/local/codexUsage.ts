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
    tooltip: `5小时额度 ${fiveHour.value}\n7天额度 ${sevenDay.value}`,
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
