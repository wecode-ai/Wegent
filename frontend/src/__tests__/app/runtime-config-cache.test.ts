/** @jest-environment node */

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { GET } from '@/app/runtime-config/route'
import { clearRuntimeConfigCache, fetchRuntimeConfig } from '@/lib/runtime-config'

describe('runtime config caching', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    clearRuntimeConfigCache()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        apiUrl: '',
        socketDirectUrl: '',
        enableChatContext: true,
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
})
