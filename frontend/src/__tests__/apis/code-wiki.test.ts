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
    put: jest.fn(),
  },
}))

describe('codeWikiApi', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('checks for an incremental update by default', async () => {
    ;(client.post as jest.Mock).mockResolvedValue({
      started: true,
      mode: 'full',
      reason: 'full rebuild explicitly requested',
      generation_id: 7,
    })

    await codeWikiApi.regenerate(12)

    expect(client.post).toHaveBeenCalledWith('/knowledge-bases/12/code-wiki/generations', {
      force_full: false,
    })
  })

  it('can explicitly request a full rebuild', async () => {
    ;(client.post as jest.Mock).mockResolvedValue({ started: true, mode: 'full' })

    await codeWikiApi.regenerate(12, true)

    expect(client.post).toHaveBeenCalledWith('/knowledge-bases/12/code-wiki/generations', {
      force_full: true,
    })
  })

  it('reads and configures the scheduled update', async () => {
    ;(client.get as jest.Mock).mockResolvedValue({ enabled: false })
    ;(client.put as jest.Mock).mockResolvedValue({ enabled: true })
    const schedule = {
      enabled: true,
      cadence: 'daily' as const,
      interval_days: 1,
      weekday: 0,
      hour: 9,
      minute: 0,
      timezone: 'Asia/Shanghai',
    }

    await codeWikiApi.scheduledUpdate(12)
    await codeWikiApi.configureScheduledUpdate(12, schedule)

    expect(client.get).toHaveBeenCalledWith('/knowledge-bases/12/code-wiki/scheduled-update')
    expect(client.put).toHaveBeenCalledWith(
      '/knowledge-bases/12/code-wiki/scheduled-update',
      schedule
    )
  })
})
