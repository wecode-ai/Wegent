import { describe, expect, test } from 'vitest'
import { applyLanguagePreference, resolvePreferredLanguage } from './languagePreference'

describe('languagePreference', () => {
  test('resolves explicit language preferences', () => {
    expect(resolvePreferredLanguage('zh-CN', 'en-US')).toBe('zh-CN')
    expect(resolvePreferredLanguage('en', 'zh-CN')).toBe('en')
  })

  test('resolves system preference from the system language', () => {
    expect(resolvePreferredLanguage('system', 'en-US')).toBe('en')
    expect(resolvePreferredLanguage('system', 'zh-CN')).toBe('zh-CN')
    expect(resolvePreferredLanguage('system', 'ja-JP')).toBe('zh-CN')
  })

  test('synchronizes the document language when i18n is already resolved', async () => {
    document.documentElement.lang = 'en'

    await expect(applyLanguagePreference('zh-CN')).resolves.toBe('zh-CN')

    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
