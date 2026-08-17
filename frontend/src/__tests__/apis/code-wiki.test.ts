// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { codeWikiApi } from '@/apis/code-wiki'
import client from '@/apis/client'

jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: {
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
})
