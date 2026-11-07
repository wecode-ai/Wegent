// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useKnowledgeGrants } from '@/features/knowledge/permission/hooks/useKnowledgeGrants'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
import type { AuthEntry } from '@/features/knowledge/document/auth-section-registry'

let mockUser = { id: 1 },
  mockScope = 'backend:session-1'
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: mockUser }) }))
jest.mock('@/apis/client', () => ({
  __esModule: true,
  ApiError: class extends Error {
    constructor(
      message: string,
      public status: number
    ) {
      super(message)
    }
  },
  default: { getCacheScope: () => mockScope },
}))
jest.mock('@/apis/knowledge-permission', () => ({
  knowledgePermissionApi: { batchAddPermission: jest.fn(), listPermissions: jest.fn() },
}))
const entries: AuthEntry[] = [
  { id: 'user-7', entityType: 'user', entityId: '7', label: 'A person', role: 'Reporter' },
  { id: 'namespace-7', entityType: 'namespace', entityId: '7', label: 'A team', role: 'Reporter' },
]
const emptyMembers = {
  pending: [],
  approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
}
beforeEach(() => {
  jest.resetAllMocks()
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValue(emptyMembers)
})

it('retains only failed targets by entity type and id after a mixed batch', async () => {
  jest.mocked(knowledgePermissionApi.batchAddPermission).mockResolvedValueOnce({
    succeeded: [{ user_id: 7, entity_type: 'user', entity_id: '7', role: 'Reporter' }],
    failed: [
      { user_id: 0, entity_type: 'namespace', entity_id: '7', error: 'temporary team failure' },
    ],
  } as never)
  const changed = jest.fn()
  const { result } = renderHook(() => useKnowledgeGrants({ kbId: 29, onChanged: changed }))
  let remaining: AuthEntry[] | null = null
  await act(async () => {
    remaining = await result.current.grant(entries)
  })
  expect(remaining).toEqual([entries[1]])
  expect(result.current.failures).toEqual([{ entry: entries[1], error: 'temporary team failure' }])
  expect(changed).toHaveBeenCalledTimes(1)
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenCalledWith(29, {
    members: [
      {
        user_id: 7,
        role: 'Reporter',
        entity_type: 'user',
        entity_id: '7',
        entity_display_name: 'A person',
      },
      {
        user_id: 0,
        role: 'Reporter',
        entity_type: 'namespace',
        entity_id: '7',
        entity_display_name: 'A team',
      },
    ],
  })
})

it('reconciles an uncertain response and resends only targets proven absent', async () => {
  jest
    .mocked(knowledgePermissionApi.batchAddPermission)
    .mockRejectedValueOnce(new Error('connection lost'))
  const { result } = renderHook(() => useKnowledgeGrants({ kbId: 29 }))
  await act(async () => {
    await result.current.grant(entries)
  })
  expect(result.current.uncertain).toBe(true)
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValueOnce({
    ...emptyMembers,
    approved: {
      ...emptyMembers.approved,
      Reporter: [
        {
          id: 1,
          user_id: 7,
          role: 'Reporter',
          display_name: 'A person',
          requested_at: '',
          entity_type: 'user',
          entity_id: '7',
        },
      ],
    },
  })
  jest.mocked(knowledgePermissionApi.batchAddPermission).mockResolvedValueOnce({
    succeeded: [{ user_id: 0, entity_type: 'namespace', entity_id: '7', role: 'Reporter' }],
    failed: [],
  } as never)
  let remaining: AuthEntry[] | null = entries
  await act(async () => {
    remaining = await result.current.grant(entries)
  })
  expect(remaining).toEqual([])
  expect(result.current.uncertain).toBe(false)
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenLastCalledWith(29, {
    members: [
      {
        user_id: 0,
        role: 'Reporter',
        entity_type: 'namespace',
        entity_id: '7',
        entity_display_name: 'A team',
      },
    ],
  })
})

it('does not post again when an uncertain result cannot be verified', async () => {
  jest
    .mocked(knowledgePermissionApi.batchAddPermission)
    .mockRejectedValueOnce(new Error('connection lost'))
  const { result } = renderHook(() => useKnowledgeGrants({ kbId: 29 }))
  await act(async () => {
    await result.current.grant(entries)
  })
  jest
    .mocked(knowledgePermissionApi.listPermissions)
    .mockRejectedValueOnce(new Error('read offline'))
  await act(async () => {
    await result.current.grant(entries)
  })
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenCalledTimes(1)
  expect(result.current.uncertain).toBe(true)
  expect(result.current.error).toBe('unconfirmed')
})

it('keeps a conflicting existing role pending without submitting a duplicate binding', async () => {
  jest.mocked(knowledgePermissionApi.batchAddPermission).mockRejectedValueOnce(new Error('unknown'))
  const { result } = renderHook(() => useKnowledgeGrants({ kbId: 29 }))
  await act(async () => {
    await result.current.grant([entries[0]])
  })
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValueOnce({
    ...emptyMembers,
    approved: {
      ...emptyMembers.approved,
      Maintainer: [
        { id: 1, user_id: 7, role: 'Maintainer', display_name: 'A person', requested_at: '' },
      ],
    },
  })
  await act(async () => {
    await result.current.grant([entries[0]])
  })
  expect(knowledgePermissionApi.batchAddPermission).toHaveBeenCalledTimes(1)
  expect(result.current.failures).toEqual([{ entry: entries[0], error: 'roleConflict' }])
  expect(result.current.uncertain).toBe(true)
})

it('honors the server batch limit while granting more than ten teams', async () => {
  const teams = Array.from({ length: 11 }, (_, index) => ({
    ...entries[1],
    id: 'team-' + index,
    entityId: String(index + 1),
  }))
  jest
    .mocked(knowledgePermissionApi.batchAddPermission)
    .mockImplementation(
      async (_id, request) =>
        ({ succeeded: request.members.map(member => ({ ...member })), failed: [] }) as never
    )
  const { result } = renderHook(() => useKnowledgeGrants({ kbId: 29 }))
  let pending: AuthEntry[] | null = null
  await act(async () => {
    pending = await result.current.grant(teams)
  })
  expect(pending).toEqual([])
  expect(
    jest
      .mocked(knowledgePermissionApi.batchAddPermission)
      .mock.calls.map(call => call[1].members.length)
  ).toEqual([10, 1])
})

it.each(['user', 'backend', 'session', 'library'])(
  'discards delayed grant results when %s changes',
  async kind => {
    let finish!: (value: never) => void
    jest.mocked(knowledgePermissionApi.batchAddPermission).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const onChanged = jest.fn()
    const { result, rerender } = renderHook(({ kbId }) => useKnowledgeGrants({ kbId, onChanged }), {
      initialProps: { kbId: 29 },
    })
    let action!: Promise<AuthEntry[] | null>
    act(() => {
      action = result.current.grant(entries)
    })
    if (kind === 'user') mockUser = { id: 2 }
    else if (kind !== 'library') mockScope = kind + ':new'
    rerender({ kbId: kind === 'library' ? 30 : 29 })
    await act(async () => {
      finish({ succeeded: [], failed: [] } as never)
      await action
    })
    expect(onChanged).not.toHaveBeenCalled()
    expect(result.current.failures).toEqual([])
    expect(result.current.loading).toBe(false)
  }
)

it('rejects Owner as a directly assignable role before sending a grant', async () => {
  const { result } = renderHook(() => useKnowledgeGrants({ kbId: 29 }))
  await act(async () => {
    await result.current.grant([{ ...entries[0], role: 'Owner' }])
  })
  expect(knowledgePermissionApi.batchAddPermission).not.toHaveBeenCalled()
  expect(result.current.error).toBe('invalidTarget')
})

it('invalidates the still-live owner after a successful write even if the grant UI was closed', async () => {
  let finish!: (value: never) => void
  jest.mocked(knowledgePermissionApi.batchAddPermission).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const onChanged = jest.fn()
  const { result, unmount } = renderHook(() => useKnowledgeGrants({ kbId: 29, onChanged }))
  let action!: Promise<AuthEntry[] | null>
  act(() => {
    action = result.current.grant([entries[0]])
  })
  unmount()
  await act(async () => {
    finish({ succeeded: [{ user_id: 7, role: 'Reporter' }], failed: [] } as never)
    await action
  })
  expect(onChanged).toHaveBeenCalledTimes(1)
})

it('does not invalidate a different backend after the closed UI completes a write', async () => {
  let finish!: (value: never) => void
  jest.mocked(knowledgePermissionApi.batchAddPermission).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const onChanged = jest.fn()
  const { result, unmount } = renderHook(() => useKnowledgeGrants({ kbId: 29, onChanged }))
  let action!: Promise<AuthEntry[] | null>
  act(() => {
    action = result.current.grant([entries[0]])
  })
  unmount()
  mockScope = 'other-backend:session'
  await act(async () => {
    finish({ succeeded: [{ user_id: 7, role: 'Reporter' }], failed: [] } as never)
    await action
  })
  expect(onChanged).not.toHaveBeenCalled()
})
