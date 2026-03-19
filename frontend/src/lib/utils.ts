// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a UTC datetime string from the backend.
 *
 * Backend stores all times in UTC but returns ISO strings without timezone suffix.
 * This function ensures the string is parsed as UTC, not local time.
 *
 * @param dateStr - ISO datetime string (e.g., "2026-01-15T01:00:00")
 * @returns Date object representing the UTC time
 */
export function parseUTCDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null

  // If already has timezone info, parse directly
  if (dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr)) {
    return new Date(dateStr)
  }

  // Backend returns UTC time without 'Z', append it
  return new Date(dateStr + 'Z')
}

/**
 * Format a UTC datetime string for display in user's local timezone.
 *
 * @param dateStr - ISO datetime string from backend (UTC)
 * @param fallback - Fallback string if dateStr is empty (default: '-')
 * @returns Formatted date string in user's local timezone
 */
export function formatUTCDate(dateStr: string | null | undefined, fallback: string = '-'): string {
  const date = parseUTCDate(dateStr)
  if (!date || isNaN(date.getTime())) return fallback
  return date.toLocaleString()
}

/**
 * Compare two semantic version strings.
 * Returns true if version >= targetVersion.
 * Supports versions like "1.6.5", "1.6.5-beta", etc.
 *
 * @param version - Current version string
 * @param targetVersion - Minimum required version string
 * @returns True if version is at least targetVersion, false if invalid
 */
export function isVersionAtLeast(version: string, targetVersion: string): boolean {
  const parseVersion = (v: string): number[] | null => {
    // Remove any pre-release suffix (e.g., "-beta", "-rc1")
    const baseVersion = v.split('-')[0]
    const parts = baseVersion.split('.').map(Number)
    // Validate all parts are valid numbers
    if (parts.some(isNaN) || parts.length === 0) {
      return null
    }
    return parts
  }

  const v1 = parseVersion(version)
  const v2 = parseVersion(targetVersion)

  // Return false if either version is invalid
  if (!v1 || !v2) return false

  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const num1 = v1[i] || 0
    const num2 = v2[i] || 0
    if (num1 > num2) return true
    if (num1 < num2) return false
  }
  return true
}
