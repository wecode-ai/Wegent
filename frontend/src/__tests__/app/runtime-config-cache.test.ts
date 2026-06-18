/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GET } from '@/app/runtime-config/route'
import {
  clearRuntimeConfigCache,
  fetchRuntimeConfig,
  getPublicApiBaseUrl,
} from '@/lib/runtime-config'

function restoreEnvValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

describe('runtime config caching', () => {
  const originalFetch = global.fetch
  const originalRuntimeDingTalkContext = process.env.RUNTIME_ENABLE_DINGTALK_CONTEXT
  const originalNextPublicDingTalkContext = process.env.NEXT_PUBLIC_ENABLE_DINGTALK_CONTEXT

  beforeEach(() => {
    clearRuntimeConfigCache()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        apiUrl: '',
        publicApiUrl: '',
        socketDirectUrl: '',
        enableChatContext: true,
        enableDingTalkContext: false,
        loginMode: 'all',
        oidcLoginText: '',
        enableDisplayQuotas: false,
        enableWiki: true,
        enableCodeKnowledgeAddRepo: true,
        vscodeLinkTemplate: '',
        feedbackUrl: 'https://github.com/wecode-ai/wegent/issues/new',
        docsUrl: 'https://wecode-ai.github.io/wegent-docs',
        otelEnabled: false,
        otelServiceName: 'wegent-frontend',
        otelCollectorEndpoint: 'http://localhost:4318',
        bindGroupDesc: '',
        bindGroupSteps: '{"variables":{"botName":"机器人"},"steps":[]}',
        appVersion: 'dev',
      }),
    }) as typeof fetch
  })

  afterEach(() => {
    jest.clearAllMocks()
    clearRuntimeConfigCache()
    restoreEnvValue('RUNTIME_ENABLE_DINGTALK_CONTEXT', originalRuntimeDingTalkContext)
    restoreEnvValue('NEXT_PUBLIC_ENABLE_DINGTALK_CONTEXT', originalNextPublicDingTalkContext)
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  test('fetchRuntimeConfig uses default cache in non-development mode', async () => {
    await fetchRuntimeConfig()

    // In test/production mode, no cache override is applied
    expect(global.fetch).toHaveBeenCalledWith('/runtime-config', {})
  })

  test('runtime config route returns caching headers in non-development mode', async () => {
    const response = await GET()

    // In test/production mode, uses caching strategy
    expect(response.headers.get('Cache-Control')).toBe('max-age=60, stale-while-revalidate=300')
  })

  test('runtime DingTalk context flag overrides build-time flag when false', async () => {
    process.env.RUNTIME_ENABLE_DINGTALK_CONTEXT = 'false'
    process.env.NEXT_PUBLIC_ENABLE_DINGTALK_CONTEXT = 'true'

    const response = await GET()
    const config = await response.json()

    expect(config.enableDingTalkContext).toBe(false)
  })

  test('getPublicApiBaseUrl uses the public backend URL from runtime config', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        apiUrl: '',
        publicApiUrl: 'http://1.1.1.1:8000',
        socketDirectUrl: '',
        enableChatContext: true,
        enableDingTalkContext: false,
        loginMode: 'all',
        oidcLoginText: '',
        enableDisplayQuotas: false,
        enableWiki: true,
        enableCodeKnowledgeAddRepo: true,
        vscodeLinkTemplate: '',
        feedbackUrl: 'https://github.com/wecode-ai/wegent/issues/new',
        docsUrl: 'https://wecode-ai.github.io/wegent-docs',
        otelEnabled: false,
        otelServiceName: 'wegent-frontend',
        otelCollectorEndpoint: 'http://localhost:4318',
        bindGroupDesc: '',
        bindGroupSteps: '{"variables":{"botName":"机器人"},"steps":[]}',
        appVersion: 'dev',
      }),
    }) as typeof fetch

    await fetchRuntimeConfig()

    expect(getPublicApiBaseUrl()).toBe('http://1.1.1.1:8000/api')
  })
})
