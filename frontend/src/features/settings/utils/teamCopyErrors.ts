// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract the Skill name from the backend agent-copy denial message so the UI
 * can show an actionable hint, e.g. "Permission denied for skill 'xxx'".
 */
export function extractDeniedSkillName(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const match = error.message.match(/Permission denied for skill '([^']+)'/)
  return match ? match[1] : null
}
