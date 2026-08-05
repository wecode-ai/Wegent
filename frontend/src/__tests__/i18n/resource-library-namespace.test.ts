// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enResourceLibrary from '@/i18n/locales/en/resource-library.json'
import zhResourceLibrary from '@/i18n/locales/zh-CN/resource-library.json'
import { initI18n } from '@/i18n/setup'

describe('resource library i18n namespace', () => {
  it('has required zh-CN and en labels', () => {
    expect(zhResourceLibrary.title).toBe('资源库')
    expect(zhResourceLibrary.tabs.discover).toBe('发现')
    expect(zhResourceLibrary.tabs.mine).toBe('我的')
    expect(zhResourceLibrary.mine.title).toBe('我的能力')
    expect(zhResourceLibrary.sources.installed).toBe('已添加')
    expect(zhResourceLibrary.actions.open_chat).toBe('去对话')
    expect(enResourceLibrary.title).toBe('Resource Library')
  })

  it('registers the resource-library namespace', async () => {
    const i18n = await initI18n()

    expect(i18n.hasResourceBundle('zh-CN', 'resource-library')).toBe(true)
    expect(i18n.hasResourceBundle('en', 'resource-library')).toBe(true)
    expect(i18n.getResource('zh-CN', 'resource-library', 'tabs.team')).toBe('团队')
    expect(i18n.getResource('zh-CN', 'resource-library', 'actions.use')).toBe('立即使用')
  })

  it('refreshes an initialized resource bundle', async () => {
    const i18n = await initI18n()
    i18n.addResourceBundle('zh-CN', 'resource-library', { actions: { use: 'stale' } }, true, true)

    await initI18n()

    expect(i18n.getResource('zh-CN', 'resource-library', 'actions.use')).toBe('立即使用')
  })
})
