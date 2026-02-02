// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Wecode i18n extension - loads and merges internal translations
 */

// Supported languages (must match main setup.ts)
const supportedLanguages = ['en', 'zh-CN']

// Wecode-specific namespaces that have extension translations
const wecodeNamespaces = ['devices']

/**
 * Load wecode extension translations and merge with base translations
 * This function is called by the main i18n setup if wecode module is available
 */
export async function loadWecodeTranslations(
  resources: Record<string, Record<string, unknown>>
): Promise<Record<string, Record<string, unknown>>> {
  for (const lng of supportedLanguages) {
    for (const ns of wecodeNamespaces) {
      try {
        // Import wecode extension translations
        const wecodeModule = await import(`./locales/${lng}/${ns}.json`)
        // Merge wecode translations into base translations (wecode overrides base)
        resources[lng][ns] = {
          ...(resources[lng][ns] as Record<string, unknown>),
          ...wecodeModule.default,
        }
      } catch {
        // Translation file not found, skip silently
      }
    }
  }

  return resources
}
