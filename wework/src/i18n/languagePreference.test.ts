import { describe, expect, test } from 'vitest'
import { resolvePreferredLanguage } from './languagePreference'

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
})
