// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

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
