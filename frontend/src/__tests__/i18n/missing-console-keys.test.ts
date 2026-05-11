// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enChat from '@/i18n/locales/en/chat.json'
import zhChat from '@/i18n/locales/zh-CN/chat.json'
import enCommon from '@/i18n/locales/en/common.json'
import zhCommon from '@/i18n/locales/zh-CN/common.json'

describe('i18n console warning keys', () => {
  test('has chat scrollbar marker translations in zh-CN and en', () => {
    expect(enChat.scroll_to_bottom).toBeTruthy()
    expect(zhChat.scroll_to_bottom).toBeTruthy()
    expect(enCommon.scroll_to_bottom).toBeTruthy()
    expect(zhCommon.scroll_to_bottom).toBeTruthy()
  })

  test('has common empty-state translations in zh-CN and en', () => {
    expect(enCommon.noData).toBeTruthy()
    expect(zhCommon.noData).toBeTruthy()
  })
})
