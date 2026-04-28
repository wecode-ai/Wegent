// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { deletePublishedApp, listPublishedApps } from '@wecode/api/published-apps'

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

  test('deletes a published app by app name', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ code: 0, message: 'success' }),
    } as unknown as Response)

    await deletePublishedApp('demo-app2')

    expect(global.fetch).toHaveBeenCalledWith('/api/published-apps/demo-app2', {
      method: 'DELETE',
      headers: {
        accept: 'application/json',
      },
    })
  })
})
