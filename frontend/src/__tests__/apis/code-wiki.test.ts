// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { codeWikiApi } from '@/apis/code-wiki'
import client from '@/apis/client'

jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}))

describe('codeWikiApi', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('makes manual regeneration an explicit full rebuild', async () => {
    ;(client.post as jest.Mock).mockResolvedValue({
      started: true,
      mode: 'full',
      reason: 'full rebuild explicitly requested',
      generation_id: 7,
    })

    await codeWikiApi.regenerate(12)

    expect(client.post).toHaveBeenCalledWith('/knowledge-bases/12/code-wiki/generations', {
      force_full: true,
    })
  })

  it('always reads the published page tree from the network', async () => {
    ;(client.get as jest.Mock).mockResolvedValue({ pages: [], published_generation_id: 7 })

    await codeWikiApi.pages(12)

    expect(client.get).toHaveBeenCalledWith('/knowledge-bases/12/code-wiki/pages', {
      cache: 'no-store',
    })
  })

  it('cancels a specific running generation', async () => {
    ;(client.post as jest.Mock).mockResolvedValue(undefined)

    await codeWikiApi.cancel(12, 7)

    expect(client.post).toHaveBeenCalledWith(
      '/knowledge-bases/12/code-wiki/generations/7/cancel',
      {}
    )
  })
})
