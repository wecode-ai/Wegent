// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Wecode i18n extension - automatically loads and registers internal translations
 *
 * This module uses i18next's addResourceBundle to merge wecode translations
 * after i18next is initialized. Import this module for side-effect.
 */

import i18next from 'i18next'

// Supported languages (must match main setup.ts)
const supportedLanguages = ['en', 'zh-CN']

// Wecode-specific namespaces that have extension translations
const wecodeNamespaces = ['devices', 'wecode']

/**
 * Load and register wecode translations into i18next
 */
async function loadWecodeResources() {
  for (const lng of supportedLanguages) {
    for (const ns of wecodeNamespaces) {
      try {
        const translations = await import(`./locales/${lng}/${ns}.json`)
        // addResourceBundle(lng, ns, resources, deep, overwrite)
        // deep=true: merge with existing, overwrite=true: overwrite existing keys
        i18next.addResourceBundle(lng, ns, translations.default, true, true)
      } catch {
        // Translation file not found, skip silently
      }
    }
  }
}

// Auto-load wecode translations when i18next is ready
if (i18next.isInitialized) {
  loadWecodeResources()
} else {
  i18next.on('initialized', () => {
    loadWecodeResources()
  })
}
