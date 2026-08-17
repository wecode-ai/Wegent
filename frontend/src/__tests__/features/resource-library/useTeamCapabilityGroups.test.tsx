// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { listGroups } from '@/apis/groups'
import { useTeamCapabilityGroups } from '@/features/resource-library/useTeamCapabilityGroups'

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(),
}))

const mockedListGroups = listGroups as jest.MockedFunction<typeof listGroups>

describe('useTeamCapabilityGroups', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedListGroups.mockResolvedValue({
      items: [
        {
          id: 1,
          name: 'platform',
          display_name: 'Platform',
          parent_name: null,
          owner_user_id: 1,
          visibility: 'private',
          description: null,
          is_active: true,
          my_role: 'Developer',
          created_at: '2026-07-31T00:00:00Z',
          updated_at: '2026-07-31T00:00:00Z',
        },
      ],
      total: 1,
    })
  })

  it('reuses loaded groups when the team tab is reopened', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useTeamCapabilityGroups({ enabled }), {
      initialProps: { enabled: true },
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(mockedListGroups).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    rerender({ enabled: true })

    expect(result.current.status).toBe('ready')
    expect(mockedListGroups).toHaveBeenCalledTimes(1)
  })

  it('allows an explicit reload after groups have loaded', async () => {
    const { result } = renderHook(() => useTeamCapabilityGroups({ enabled: true }))

    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      await result.current.reload()
    })

    expect(mockedListGroups).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('ready')
  })
})
