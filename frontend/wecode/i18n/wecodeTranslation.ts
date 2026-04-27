// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enWecode from './locales/en/wecode.json'
import zhCNWecode from './locales/zh-CN/wecode.json'

type TranslationValue = string | TranslationTree

interface TranslationTree {
  [key: string]: TranslationValue
}

const resources: Record<string, TranslationTree> = {
  en: enWecode,
  'zh-CN': zhCNWecode,
}

function normalizeLanguage(language?: string): 'en' | 'zh-CN' {
  return language?.startsWith('zh') ? 'zh-CN' : 'en'
}

function readNestedValue(tree: TranslationTree, key: string): string | null {
  const value = key.split('.').reduce<TranslationValue | undefined>((current, segment) => {
    if (!current || typeof current === 'string') {
      return undefined
    }
    return current[segment]
  }, tree)

  return typeof value === 'string' ? value : null
}

function interpolate(value: string, options?: Record<string, unknown>): string {
  if (!options) {
    return value
  }

  return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const replacement = options[key]
    return replacement == null ? match : String(replacement)
  })
}

export function translateWecodeKey(
  key: string,
  i18nextValue: string,
  language?: string,
  options?: Record<string, unknown>
): string {
  if (i18nextValue !== key) {
    return i18nextValue
  }

  const normalizedLanguage = normalizeLanguage(language)
  const fallback = readNestedValue(resources[normalizedLanguage], key)

  return fallback ? interpolate(fallback, options) : i18nextValue
}
