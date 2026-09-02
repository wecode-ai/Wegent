// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enAdmin from '@/i18n/locales/en/admin.json'
import zhAdmin from '@/i18n/locales/zh-CN/admin.json'
import { initI18n } from '@/i18n/setup'

function collectKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

describe('plugin publication review i18n', () => {
  it('keeps the complete review translation contract aligned in Chinese and English', () => {
    const en = enAdmin.marketplace_management.plugin_publications
    const zh = zhAdmin.marketplace_management.plugin_publications

    expect(collectKeys(en).sort()).toEqual(collectKeys(zh).sort())
    expect(zh.actions.accept).toBeTruthy()
    expect(zh.actions.return).toBeTruthy()
    expect(zh.actions.reconcile).toBeTruthy()
    expect(zh.accept_dialog.not_publish_notice).toBeTruthy()
    expect(en.accept_dialog.not_publish_notice).toBeTruthy()
    expect(zhAdmin.tabs.wework_plugin_publications).toBeTruthy()
    expect(enAdmin.tabs.wework_plugin_publications).toBeTruthy()
  })

  it('loads marketplace and Wework review labels through the admin namespace', async () => {
    const i18n = await initI18n()
    await i18n.changeLanguage('zh-CN')

    expect(i18n.t('tabs.marketplace', { ns: 'admin' })).toBe('Wegent 市场管理')
    expect(i18n.t('tabs.wework_plugin_publications', { ns: 'admin' })).toBe('Wework 插件审核')
    expect(i18n.t('marketplace_management.plugin_publications.title', { ns: 'admin' })).toBe(
      'Wework 插件发布审核'
    )
  })
})
