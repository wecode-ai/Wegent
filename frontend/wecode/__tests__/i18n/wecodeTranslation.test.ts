// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { translateWecodeKey } from '@wecode/i18n/wecodeTranslation'

describe('translateWecodeKey', () => {
  test('falls back to zh-CN wecode translations when i18next returns the key', () => {
    expect(translateWecodeKey('published_apps.title', 'published_apps.title', 'zh-CN')).toBe(
      '已发布的应用'
    )
  })

  test('interpolates values in fallback translations', () => {
    expect(
      translateWecodeKey('published_apps.summary', 'published_apps.summary', 'zh-CN', {
        count: 3,
      })
    ).toBe('共 3 个应用')
  })

  test('keeps the i18next value when the namespace is already loaded', () => {
    expect(translateWecodeKey('published_apps.title', 'Published Apps', 'en')).toBe(
      'Published Apps'
    )
  })
})
