// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import enAdmin from '@/i18n/locales/en/admin.json'
import zhAdmin from '@/i18n/locales/zh-CN/admin.json'

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
    expect(zhAdmin.marketplace_management.plugin_publication_view).toBeTruthy()
    expect(enAdmin.marketplace_management.plugin_publication_view).toBeTruthy()
  })
})
