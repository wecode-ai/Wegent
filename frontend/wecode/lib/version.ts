// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Compare two semantic version strings.
 * Supports formats like "1.6.5", "1.6.5-beta", "1.6.5.1"
 * Non-numeric parts (like -beta) are ignored for comparison
 *
 * Returns:
 *   > 0 if v1 > v2
 *   = 0 if v1 = v2
 *   < 0 if v1 < v2
 */
export function compareVersions(v1: string, v2: string): number {
  // Extract numeric parts only (e.g., "1.6.5-beta" -> [1, 6, 5])
  const parseVersion = (v: string): number[] => {
    // Remove leading 'v' if present, and take only the numeric prefix
    const clean = v.replace(/^v/, '').split('-')[0]
    return clean.split('.').map(Number).filter(n => !isNaN(n))
  }

  const parts1 = parseVersion(v1)
  const parts2 = parseVersion(v2)
  const maxLength = Math.max(parts1.length, parts2.length)

  for (let i = 0; i < maxLength; i++) {
    const p1 = parts1[i] ?? 0
    const p2 = parts2[i] ?? 0
    if (p1 !== p2) return p1 - p2
  }
  return 0
}

/**
 * Check if version meets minimum requirement.
 * @param version - Current version string
 * @param minimum - Minimum required version
 * @returns true if version >= minimum
 */
export function isVersionAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0
}
