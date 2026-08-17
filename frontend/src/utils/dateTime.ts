// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { parseUTCDate } from '@/lib/utils'

/**
 * Format a timestamp to ISO 8601 date-time string: YYYY-MM-DD HH:mm:ss
 * Uses user's local timezone.
 *
 * @param timestamp - Unix timestamp in milliseconds or undefined
 * @returns Formatted date-time string in format "YYYY-MM-DD HH:mm:ss" or empty string if invalid
 *
 * @example
 * formatDateTime(1705312513000) // "2025-01-15 13:45:13"
 * formatDateTime(undefined) // ""
 */
export const formatDateTime = (timestamp: number | undefined): string => {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return ''
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

/**
 * Format an ISO date string to date only: YYYY/MM/DD
 * Uses user's local timezone.
 *
 * @param dateString - ISO 8601 date string or undefined/null
 * @returns Formatted date string in format "YYYY/MM/DD" or empty string if invalid
 *
 * @example
 * formatDate("2026-01-15T13:45:13Z") // "2026/01/15"
 * formatDate(undefined) // ""
 */
export const formatDate = (dateString: string | null | undefined): string => {
  if (!dateString) return ''
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

/**
 * How long ago something happened, in words.
 *
 * The same four-branch calculation is written inline in several feed components; this
 * is the shared version, so new callers do not add a fifth copy. Those components are
 * deliberately left alone here — two of them read the strings from a different i18n
 * namespace, and reconciling that belongs to a change about the feed, not this one.
 *
 * Timestamps arrive from the API without a zone. `parseUTCDate` reads them as UTC,
 * which is what they are; treating them as local would make everything generated in
 * the last few hours read as being in the future.
 *
 * @param dateString - ISO 8601 date string from the API
 * @param t - translator, for the `common:time.*` keys
 * @returns A phrase like "3 分钟前", or an empty string when the input is unusable
 */
export const formatRelativeTime = (
  dateString: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): string => {
  const date = parseUTCDate(dateString)
  if (!date || Number.isNaN(date.getTime())) return ''

  const elapsed = Date.now() - date.getTime()
  const minutes = Math.floor(elapsed / 60000)
  if (minutes < 1) return t('common:time.just_now')
  if (minutes < 60) return t('common:time.minutes_ago', { count: minutes })

  const hours = Math.floor(elapsed / 3600000)
  if (hours < 24) return t('common:time.hours_ago', { count: hours })

  return t('common:time.days_ago', { count: Math.floor(elapsed / 86400000) })
}
