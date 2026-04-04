// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import client from '@/apis/client'

jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
  },
}))

describe('knowledgePermissionApi.listPermissions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not fetch pending requests unless explicitly requested', async () => {
    ;(client.get as jest.Mock).mockResolvedValueOnce({
      members: [],
      total: 0,
    })

    const result = await knowledgePermissionApi.listPermissions(12)

    expect(client.get).toHaveBeenCalledTimes(1)
    expect(client.get).toHaveBeenCalledWith('/share/KnowledgeBase/12/members')
    expect(result.pending).toEqual([])
  })

  it('fetches and transforms pending requests when requested', async () => {
    ;(client.get as jest.Mock)
      .mockResolvedValueOnce({
        members: [],
        total: 0,
      })
      .mockResolvedValueOnce({
        requests: [
          {
            id: 7,
            user_id: 3,
            user_name: 'alice',
            user_email: 'alice@example.com',
            requested_role: 'Developer',
            requested_at: '2026-04-03T00:00:00Z',
          },
        ],
        total: 1,
      })

    const result = await knowledgePermissionApi.listPermissions(12, {
      includePendingRequests: true,
    })

    expect(client.get).toHaveBeenNthCalledWith(1, '/share/KnowledgeBase/12/members')
    expect(client.get).toHaveBeenNthCalledWith(2, '/share/KnowledgeBase/12/requests')
    expect(result.pending).toEqual([
      {
        id: 7,
        user_id: 3,
        username: 'alice',
        email: 'alice@example.com',
        role: 'Developer',
        requested_at: '2026-04-03T00:00:00Z',
      },
    ])
  })
})
