import { createHttpClient } from './http'
import { createQuotaApi, type QuotaData } from './quota'

export interface WegentUsageDisplay {
  status: 'available' | 'none'
  sourceText: string
  sourceLabel: string
  quota: number
  usage: number
  remaining: number
  usageRate: number | null
  value: string
  detail: string
  trayTitle: string
  tooltip: string
}

export interface WegentQuotaConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
}

function isEnglishLocale(): boolean {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en')
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function formatAmount(value: number): string {
  return value.toLocaleString(isEnglishLocale() ? 'en-US' : 'zh-CN', {
    maximumFractionDigits: 2,
  })
}

function usageRate(data: QuotaData): number | null {
  if (data.quota === 0) return null
  return (data.usage / data.quota) * 100
}

function formatRate(value: number | null): string {
  if (value === null) return '--'
  return value.toLocaleString(isEnglishLocale() ? 'en-US' : 'zh-CN', {
    maximumFractionDigits: 2,
  })
}

export function extractQuotaSourceLabel(value: string | null | undefined): string {
  const letters = value?.match(/[A-Za-z]/g)?.join('') ?? ''
  return letters.slice(0, 5) || 'Quota'
}

export function formatWegentUsageDisplay(data: QuotaData | null | undefined): WegentUsageDisplay {
  if (!data) {
    return {
      status: 'none',
      sourceText: '',
      sourceLabel: 'Quota',
      quota: 0,
      usage: 0,
      remaining: 0,
      usageRate: null,
      value: '--',
      detail: '',
      trayTitle: 'Quota --',
      tooltip: '',
    }
  }

  const english = isEnglishLocale()
  const quota = finiteNumber(data.quota)
  const usage = finiteNumber(data.usage)
  const remaining = finiteNumber(data.remaining)
  const rate = usageRate(data)
  const sourceLabel = extractQuotaSourceLabel(data.quota_source)
  const sourceText = english ? `${sourceLabel} quota` : `${sourceLabel}额度`
  const unit = english ? ' Yuan' : ' 元'
  const value = `${formatAmount(usage)} / ${formatAmount(quota)}${unit}`
  const detail = english
    ? `Used ${formatRate(rate)}% · Remaining ${formatAmount(remaining)}${unit}`
    : `已用 ${formatRate(rate)}% · 剩余 ${formatAmount(remaining)}${unit}`

  return {
    status: 'available',
    sourceText,
    sourceLabel,
    quota,
    usage,
    remaining,
    usageRate: rate,
    value,
    detail,
    trayTitle: `${sourceLabel} ${formatAmount(remaining)}`,
    tooltip: `${sourceText}\n${value} (${formatRate(rate)}%)\n${
      english ? 'Remaining' : '剩余'
    } ${formatAmount(remaining)}${unit}`,
  }
}

export function emptyWegentUsageDisplay(): WegentUsageDisplay {
  return formatWegentUsageDisplay(null)
}

export async function getWegentUsageDisplay(
  connection: WegentQuotaConnection
): Promise<WegentUsageDisplay> {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    return emptyWegentUsageDisplay()
  }

  const quotaApi = createQuotaApi(
    createHttpClient({
      baseUrl: connection.apiBaseUrl,
      getToken: () => connection.token,
      redirectOnUnauthorized: false,
    })
  )
  return formatWegentUsageDisplay(await quotaApi.fetchQuota())
}
