// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from 'i18next'

/**
 * I18n title structure returned from backend
 * Can be either a plain i18n key string or an object with key and params
 */
export type I18nTitle =
  | string
  | {
      key: string
      params?: Record<string, string | number>
    }

/**
 * Check if a string looks like an i18n key
 * I18n keys are in the format "namespace.key.subkey" (e.g., "tools.knowledge_base.display_name")
 */
function isI18nKey(value: string): boolean {
  // Must contain dots and no spaces, and start with a valid namespace prefix
  return /^tools\.[a-z_]+\.[a-z_]+$/.test(value)
}

/**
 * Parse and translate i18n title from backend
 *
 * The title can be in three formats:
 * 1. A plain string that is NOT an i18n key (e.g., "Custom tool name") - returned as-is
 * 2. An i18n key string (e.g., "tools.knowledge_base.display_name") - translated
 * 3. An object with key and params (e.g., { key: "tools.web_search.completed", params: { count: 5 } }) - translated with interpolation
 *
 * @param title - The title from backend (string or object)
 * @param t - i18next translation function
 * @param namespace - Optional namespace prefix (default: 'chat')
 * @returns Translated string
 */
export function parseI18nTitle(
  title: I18nTitle | undefined | null,
  t: TFunction,
  namespace: string = 'chat'
): string {
  if (!title) {
    return ''
  }

  // Handle object format: { key: "...", params: { ... } }
  if (typeof title === 'object' && 'key' in title) {
    const fullKey = `${namespace}:${title.key}`
    const translated = t(fullKey, title.params || {})
    // If translation returns the key itself, it means no translation was found
    return translated !== fullKey ? translated : title.key
  }

  // Handle string format
  if (typeof title === 'string') {
    // Check if it looks like an i18n key
    if (isI18nKey(title)) {
      const fullKey = `${namespace}:${title}`
      const translated = t(fullKey)
      // If translation returns the key itself, return the original value
      return translated !== fullKey ? translated : title
    }
    // Not an i18n key, return as-is
    return title
  }

  return String(title)
}
