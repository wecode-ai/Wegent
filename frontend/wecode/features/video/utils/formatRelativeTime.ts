// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Relative/short time formatting for video features.
 *
 * Rules (same as StoryboardVersionSelector):
 * - Today, < 10 min        → "刚刚"
 * - Today, 10–59 min        → "x分钟前"
 * - Today, ≥ 60 min         → "x小时前" (capped at 23)
 * - Yesterday               → "昨天 HH:mm"
 * - This year (other days)  → "M-D HH:mm"
 * - Previous years          → "YY-MM-DD"
 *
 * Returns '' for invalid/empty input.
 */

function padToTwoDigits(value: number) {
  return String(value).padStart(2, '0')
}

function isSameDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

export function formatRelativeTime(timestamp?: string): string {
  if (!timestamp) return ''

  const publishDate = new Date(timestamp)

  if (Number.isNaN(publishDate.getTime())) {
    return ''
  }

  const now = new Date()
  const diffMs = Math.max(0, now.getTime() - publishDate.getTime())
  const minutes = Math.floor(diffMs / (60 * 1000))
  const hours = Math.floor(diffMs / (60 * 60 * 1000))
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)

  if (isSameDate(publishDate, now)) {
    if (minutes < 10) {
      return '刚刚'
    }

    if (minutes < 60) {
      return `${minutes}分钟前`
    }

    return `${Math.min(hours, 23)}小时前`
  }

  if (isSameDate(publishDate, yesterday)) {
    return `昨天 ${padToTwoDigits(publishDate.getHours())}:${padToTwoDigits(
      publishDate.getMinutes()
    )}`
  }

  if (publishDate.getFullYear() < now.getFullYear()) {
    return `${String(publishDate.getFullYear()).slice(-2)}-${padToTwoDigits(
      publishDate.getMonth() + 1
    )}-${padToTwoDigits(publishDate.getDate())}`
  }

  return `${publishDate.getMonth() + 1}-${padToTwoDigits(publishDate.getDate())} ${padToTwoDigits(
    publishDate.getHours()
  )}:${padToTwoDigits(publishDate.getMinutes())}`
}
