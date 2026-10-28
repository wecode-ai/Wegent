// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'

import { listGroups } from '@/apis/groups'
import { useWritableGroups } from '@/hooks/useWritableGroups'
import type { Group } from '@/types/group'

jest.mock('@/apis/groups', () => ({
  listGroups: jest.fn(),
}))

function makeGroup(name: string, myRole: Group['my_role']): Group {
  return {
    id: name.length,
    name,
    display_name: null,
    parent_name: null,
    owner_user_id: 1,
    visibility: 'internal',
    description: null,
    is_active: true,
    my_role: myRole,
    created_at: '',
    updated_at: '',
  }
}

describe('useWritableGroups', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(listGroups as jest.Mock).mockResolvedValue({ total: 0, items: [] })
  })

  it('keeps only groups where the user can edit content', async () => {
    ;(listGroups as jest.Mock).mockResolvedValue({
      items: [
        makeGroup('owner', 'Owner'),
        makeGroup('maintainer', 'Maintainer'),
        makeGroup('developer', 'Developer'),
        makeGroup('reporter', 'Reporter'),
        makeGroup('guest', 'RestrictedAnalyst'),
        makeGroup('unknown', undefined),
      ],
    })

    const { result } = renderHook(() => useWritableGroups())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(result.current.groups.map(group => group.name)).toEqual([
      'owner',
      'maintainer',
      'developer',
    ])
  })

  it('waits for enablement and reloads on demand', async () => {
    ;(listGroups as jest.Mock).mockResolvedValue({
      items: [makeGroup('developer', 'Developer')],
    })

    const { result } = renderHook(() => useWritableGroups(false))
    expect(listGroups).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.groups.map(group => group.name)).toEqual(['developer'])
  })

  it('loads every page before filtering writable groups', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      makeGroup(`first-${index}`, index === 0 ? 'Reporter' : 'Developer')
    )
    const secondPage = Array.from({ length: 50 }, (_, index) =>
      makeGroup(`second-${index}`, 'Developer')
    )
    ;(listGroups as jest.Mock)
      .mockResolvedValueOnce({ total: 150, items: firstPage })
      .mockResolvedValueOnce({ total: 150, items: secondPage })

    const { result } = renderHook(() => useWritableGroups())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.groups).toHaveLength(149)
    expect(listGroups).toHaveBeenNthCalledWith(1, { page: 1, limit: 100 })
    expect(listGroups).toHaveBeenNthCalledWith(2, { page: 2, limit: 100 })
  })

  it('exposes a load error and clears it after retry', async () => {
    ;(listGroups as jest.Mock)
      .mockRejectedValueOnce(new Error('group load failed'))
      .mockResolvedValueOnce({
        total: 1,
        items: [makeGroup('developer', 'Developer')],
      })

    const { result } = renderHook(() => useWritableGroups())

    await waitFor(() => {
      expect(result.current.error?.message).toBe('group load failed')
    })
    expect(result.current.groups).toEqual([])

    await act(async () => {
      await result.current.reload()
    })

    expect(result.current.error).toBeNull()
    expect(result.current.groups.map(group => group.name)).toEqual(['developer'])
  })

  it('refreshes groups when a dialog is reopened', async () => {
    ;(listGroups as jest.Mock).mockResolvedValue({
      total: 1,
      items: [makeGroup('developer', 'Developer')],
    })

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useWritableGroups(enabled),
      { initialProps: { enabled: true } }
    )

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })
    expect(listGroups).toHaveBeenCalledTimes(1)

    rerender({ enabled: false })
    rerender({ enabled: true })

    await waitFor(() => {
      expect(listGroups).toHaveBeenCalledTimes(2)
    })
  })
})
