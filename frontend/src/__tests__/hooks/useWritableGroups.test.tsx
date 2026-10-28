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
})
