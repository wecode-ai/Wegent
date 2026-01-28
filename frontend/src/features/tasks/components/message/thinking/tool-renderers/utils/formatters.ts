// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null) {
    return ''
  }

  if (bytes === 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  if (i >= units.length) {
    return `${(bytes / Math.pow(k, units.length - 1)).toFixed(1)} ${units[units.length - 1]}`
  }

  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) {
    return ''
  }

  if (ms < 1000) {
    return `${ms}ms`
  }

  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`
}

/**
 * Extract file name from path
 */
export function extractFileName(filePath: string | undefined | null): string {
  if (!filePath) return ''
  const parts = filePath.split('/')
  return parts[parts.length - 1] || ''
}

/**
 * Format line count
 */
export function formatLineCount(count: number | undefined | null): string {
  if (count === undefined || count === null) {
    return ''
  }
  return count.toLocaleString()
}

/**
 * Format match count for search tools
 */
export function formatMatchCount(count: number | undefined | null): string {
  if (count === undefined || count === null) {
    return ''
  }
  return count.toLocaleString()
}

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  return text.slice(0, maxLength - 3) + '...'
}
