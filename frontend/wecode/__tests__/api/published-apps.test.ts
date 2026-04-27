// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { listPublishedApps } from '@wecode/api/published-apps'

describe('listPublishedApps', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test('uses backend detail as the thrown error message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      text: jest.fn().mockResolvedValue('{"detail":"Published apps service request timed out"}'),
    } as unknown as Response)

    await expect(listPublishedApps()).rejects.toThrow(/^Published apps service request timed out$/)
  })
})
