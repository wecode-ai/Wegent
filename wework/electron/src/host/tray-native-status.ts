import type { PreferencesStore } from './preferences-store.js'
import type { TrayNativeStatus } from './tray-manager.js'

const REFRESH_INTERVAL_MS = 60_000
const FIVE_HOUR_MINUTES = 5 * 60
const SEVEN_DAY_MINUTES = 7 * 24 * 60

interface CodexRateLimitWindow {
  usedPercent?: unknown
  windowDurationMins?: unknown
}

interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow | null
  secondary?: CodexRateLimitWindow | null
}

interface CodexRateLimitsResponse {
  rateLimits?: CodexRateLimitSnapshot | null
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot | undefined> | null
}

interface CodexHomeStatus {
  shouldPromptMigration?: unknown
}

interface RuntimeRunningCountResponse {
  runningCount?: unknown
}

interface BackendQuotaResponse {
  data?: {
    remaining?: unknown
    quota_source?: unknown
  } | null
  quota_source?: unknown
}

export interface TrayNativeStatusDependencies {
  preferences: PreferencesStore
  requestExecutor: <Result>(method: string, params?: Record<string, unknown>) => Promise<Result>
  apply: (status: TrayNativeStatus) => void
  logError?: (message: string, error: unknown) => void
}

export class TrayNativeStatusController {
  private interval: NodeJS.Timeout | null = null
  private refreshPromise: Promise<void> | null = null
  private refreshRequested = false

  constructor(private readonly dependencies: TrayNativeStatusDependencies) {}

  start(): void {
    if (this.interval) return
    void this.refresh()
    this.interval = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS)
    this.interval.unref()
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) {
      this.refreshRequested = true
      return this.refreshPromise
    }
    this.refreshPromise = this.runRefreshes().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  handleExecutorEvent(event: string): void {
    if (
      event === 'response.created' ||
      event === 'response.completed' ||
      event === 'response.failed' ||
      event === 'response.incomplete'
    ) {
      void this.refresh()
    }
  }

  private async runRefreshes(): Promise<void> {
    do {
      this.refreshRequested = false
      await this.refreshNow()
    } while (this.refreshRequested)
  }

  private async refreshNow(): Promise<void> {
    const preferences = await this.dependencies.preferences.read()
    const language = normalizedLanguage(preferences.language)
    const showRunningStatus = preferences.trayRunningEnabled !== false
    const [running, codex, wegent] = await Promise.all([
      showRunningStatus
        ? this.read<RuntimeRunningCountResponse>('runtime.tasks.running_count')
        : Promise.resolve(null),
      this.readCodexRateLimits(preferences.trayUsageEnabled !== false),
      preferences.trayWegentUsageEnabled !== false
        ? this.read<BackendQuotaResponse>('executor.backend.quota')
        : Promise.resolve(null),
    ])
    const runningCount =
      typeof running?.runningCount === 'number' &&
      Number.isInteger(running.runningCount) &&
      running.runningCount > 0
        ? running.runningCount
        : 0
    const codexDisplay = formatCodexUsage(codex, language)
    const wegentDisplay = formatBackendQuota(wegent, language)
    const tooltip = [
      runningCount > 0
        ? language === 'en'
          ? `${runningCount} task${runningCount === 1 ? '' : 's'} running`
          : `${runningCount} 个任务运行中`
        : null,
      codexDisplay?.tooltip ?? null,
      wegentDisplay?.tooltip ?? null,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n')
    this.dependencies.apply({
      usageTitle: buildUsageTitle(codexDisplay?.title ?? null, wegentDisplay?.title ?? null),
      usageTooltip: tooltip || null,
      runningCount,
      showRunningStatus,
    })
  }

  private async readCodexRateLimits(enabled: boolean): Promise<CodexRateLimitsResponse | null> {
    if (!enabled) return null
    const home = await this.read<CodexHomeStatus>('executor.codex_home.status')
    if (!home || home.shouldPromptMigration === true) return null
    return this.read<CodexRateLimitsResponse>('runtime.codex.rate_limits.read')
  }

  private async read<Result>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<Result | null> {
    try {
      return params
        ? await this.dependencies.requestExecutor<Result>(method, params)
        : await this.dependencies.requestExecutor<Result>(method)
    } catch (error) {
      this.dependencies.logError?.(`[tray] failed to refresh ${method}`, error)
      return null
    }
  }
}

function normalizedLanguage(value: unknown): 'en' | 'zh-CN' {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
}

function remainingPercent(window: CodexRateLimitWindow | null | undefined): number | null {
  if (typeof window?.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null
  return Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)))
}

function formatCodexUsage(
  response: CodexRateLimitsResponse | null,
  language: 'en' | 'zh-CN'
): { title: string; tooltip: string } | null {
  const snapshot = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits
  const windows = [snapshot?.primary, snapshot?.secondary]
  const fiveHour = remainingPercent(
    windows.find(window => window?.windowDurationMins === FIVE_HOUR_MINUTES)
  )
  const sevenDay = remainingPercent(
    windows.find(window => window?.windowDurationMins === SEVEN_DAY_MINUTES)
  )
  if (fiveHour === null && sevenDay === null) return null
  const fiveHourText = fiveHour === null ? '--' : `${fiveHour}%`
  const sevenDayText = sevenDay === null ? '--' : `${sevenDay}%`
  return {
    title: `5h ${fiveHourText}\n7d ${sevenDayText}`,
    tooltip:
      language === 'en'
        ? `Codex quota\n5-hour quota ${fiveHourText}\n7-day quota ${sevenDayText}`
        : `Codex 额度\n5小时额度 ${fiveHourText}\n7天额度 ${sevenDayText}`,
  }
}

function quotaSource(value: unknown): string {
  if (typeof value !== 'string') return 'Quota'
  return (
    value
      .match(/[A-Za-z]/g)
      ?.join('')
      .slice(0, 5) || 'Quota'
  )
}

function formatBackendQuota(
  response: BackendQuotaResponse | null,
  language: 'en' | 'zh-CN'
): { title: string; tooltip: string } | null {
  const data = response?.data
  if (!data || typeof data.remaining !== 'number' || !Number.isFinite(data.remaining)) return null
  const source = quotaSource(response.quota_source ?? data.quota_source)
  const remaining = data.remaining.toLocaleString(language === 'en' ? 'en-US' : 'zh-CN', {
    maximumFractionDigits: 2,
  })
  return {
    title: `${source} ${remaining}`,
    tooltip:
      language === 'en'
        ? `${source} quota\nRemaining ${remaining} Yuan`
        : `${source}额度\n剩余 ${remaining} 元`,
  }
}

function compactCodexTitle(title: string): string {
  const percentages = title
    .match(/\d+%/g)
    ?.map(value => Number(value.slice(0, -1)))
    .filter(Number.isFinite)
  return `Codex  ${percentages?.length ? `${Math.min(...percentages)}%` : '--'}`
}

function buildUsageTitle(codex: string | null, wegent: string | null): string | null {
  if (!codex) return wegent
  if (!wegent) return codex
  return `${compactCodexTitle(codex)}\n${wegent}`
}
