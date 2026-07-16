// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildChatCodeHref,
  getCodingEntryHref,
  getCodingNavItem,
  isExternalHref,
} from '@/config/coding-route'
import type { RuntimeConfig } from '@/lib/runtime-config'

const baseConfig: RuntimeConfig = {
  apiUrl: '',
  publicApiUrl: '',
  socketDirectUrl: '',
  enableChatContext: true,
  loginMode: 'all',
  oidcLoginText: '',
  enableDisplayQuotas: false,
  enableWiki: true,
  enableCodeKnowledgeAddRepo: true,
  enableProjectWorkspace: false,
  projectWorkspaceWhitelist: '',
  vscodeLinkTemplate: '',
  feedbackUrl: 'https://github.com/wecode-ai/wegent/issues/new',
  docsUrl: 'https://wecode-ai.github.io/wegent-docs',
  otelEnabled: false,
  otelServiceName: 'wegent-frontend',
  otelCollectorEndpoint: 'http://localhost:4318',
  bindGroupDesc: '',
  bindGroupSteps: '{"variables":{"botName":"机器人"},"steps":[]}',
  appVersion: 'dev',
  weworkCodeUrl: '',
}

describe('coding route helpers', () => {
  test('buildChatCodeHref preserves existing query params and forces code agent mode', () => {
    const params = new URLSearchParams('taskId=42&agent=chat')

    expect(buildChatCodeHref(params)).toBe('/chat?taskId=42&agent=code')
  })

  test('getCodingEntryHref returns chat code mode when Wework URL is not configured', () => {
    expect(getCodingEntryHref(baseConfig)).toBe('/chat?agent=code')
  })

  test('getCodingEntryHref returns configured Wework URL when present', () => {
    expect(
      getCodingEntryHref({
        ...baseConfig,
        weworkCodeUrl: ' https://wework.example.com/coding ',
      })
    ).toBe('https://wework.example.com/coding')
  })

  test('isExternalHref detects absolute URLs and custom schemes', () => {
    expect(isExternalHref('https://wework.example.com/coding')).toBe(true)
    expect(isExternalHref('//wework.example.com/coding')).toBe(true)
    expect(isExternalHref('wework://coding')).toBe(true)
    expect(isExternalHref('/chat?agent=code')).toBe(false)
  })

  test('getCodingNavItem shows Code without Wework URL and WeWork with Wework URL', () => {
    expect(getCodingNavItem(baseConfig)).toMatchObject({
      key: 'code',
      labelKey: 'common:navigation.code',
      href: '/chat?agent=code',
      external: false,
    })

    expect(
      getCodingNavItem({
        ...baseConfig,
        weworkCodeUrl: 'https://wework.example.com/coding',
      })
    ).toMatchObject({
      key: 'wework',
      labelKey: 'common:navigation.wework',
      href: 'https://wework.example.com/coding',
      external: true,
    })
  })
})
