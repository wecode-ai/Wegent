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
 * Sanitize filename by removing zero-width and invisible Unicode characters.
 *
 * These characters can cause issues with S3 storage and other systems:
 * - U+200B: Zero Width Space
 * - U+200C: Zero Width Non-Joiner
 * - U+200D: Zero Width Joiner
 * - U+FEFF: Zero Width No-Break Space (BOM)
 * - U+2060-2064: Word Joiner and invisible operators
 * - U+206A-206F: Invisible format characters
 *
 * @param filename - Original filename
 * @returns Sanitized filename with invisible characters removed
 */
export function sanitizeFilename(filename: string): string {
  // Pattern to match zero-width and invisible characters
  // U+200B-U+200D, U+FEFF, U+2060-U+206F
  return filename.replace(/[\u200B-\u200D\uFEFF\u2060-\u206F]+/g, '')
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
