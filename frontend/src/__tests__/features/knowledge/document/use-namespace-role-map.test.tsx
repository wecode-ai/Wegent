// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from '@testing-library/react'
import {
  clearNamespaceRoleMapCache,
  useNamespaceRoleMap,
  useNamespaceRoleState,
} from '@/features/knowledge/document/hooks/useNamespaceRoleMap'

let mockUser = { id: 1 }
let mockScope = 'backend:session-1'
const mockListGroups = jest.fn()
jest.mock('@/apis/client', () => ({
  __esModule: true,
  default: { getCacheScope: () => mockScope },
}))
jest.mock('@/apis/groups', () => ({ listGroups: (params: unknown) => mockListGroups(params) }))
jest.mock('@/features/common/UserContext', () => ({ useUser: () => ({ user: mockUser }) }))

beforeEach(() => {
  clearNamespaceRoleMapCache()
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  mockListGroups.mockReset()
})

it.each(['user', 'backend', 'session'])(
  'isolates role cache on %s changes and discards old responses',
  async kind => {
    let resolveOld!: (value: unknown) => void
    mockListGroups.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    const { result, rerender } = renderHook(() => useNamespaceRoleMap())
    mockListGroups.mockResolvedValueOnce({ items: [{ name: 'new-space', my_role: 'Reporter' }] })
    if (kind === 'user') mockUser = { id: 2 }
    else mockScope = kind + ':next'
    rerender()
    expect(result.current.size).toBe(0)
    await waitFor(() => expect(result.current.get('new-space')).toBe('Reporter'))
    await act(async () => resolveOld({ items: [{ name: 'old-space', my_role: 'Owner' }] }))
    expect(result.current.has('old-space')).toBe(false)
    expect(result.current.get('new-space')).toBe('Reporter')
  }
)

it('reuses reads within the same scope but never returns another account role', async () => {
  mockListGroups.mockResolvedValueOnce({ items: [{ name: 'space', my_role: 'Owner' }] })
  const first = renderHook(() => useNamespaceRoleMap())
  await waitFor(() => expect(first.result.current.get('space')).toBe('Owner'))
  first.unmount()
  const second = renderHook(() => useNamespaceRoleMap())
  await waitFor(() => expect(second.result.current.get('space')).toBe('Owner'))
  expect(mockListGroups).toHaveBeenCalledTimes(1)
  second.unmount()
  mockUser = { id: 2 }
  mockListGroups.mockResolvedValueOnce({ items: [] })
  const third = renderHook(() => useNamespaceRoleMap())
  expect(third.result.current.size).toBe(0)
  await waitFor(() => expect(mockListGroups).toHaveBeenCalledTimes(2))
  expect(third.result.current.size).toBe(0)
})

it('reloads an explicitly invalidated in-flight read within the same scope', async () => {
  let resolveOld!: (value: unknown) => void
  mockListGroups.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveOld = resolve
      })
  )
  const { result } = renderHook(() => useNamespaceRoleMap())
  clearNamespaceRoleMapCache()
  mockListGroups.mockResolvedValueOnce({ items: [{ name: 'space', my_role: 'Reporter' }] })
  await act(async () => resolveOld({ items: [{ name: 'space', my_role: 'Owner' }] }))
  await waitFor(() => expect(result.current.get('space')).toBe('Reporter'))
  expect(mockListGroups).toHaveBeenCalledTimes(2)
})

it('loads every group page before exposing the complete role set', async () => {
  mockListGroups.mockResolvedValueOnce({
    items: Array.from({ length: 100 }, (_, id) => ({ name: `space-${id}`, my_role: 'Reporter' })),
    total: 101,
  })
  mockListGroups.mockResolvedValueOnce({
    items: [{ name: 'last-space', my_role: 'Owner' }],
    total: 101,
  })
  const { result } = renderHook(() => useNamespaceRoleMap())
  await waitFor(() => expect(result.current.get('last-space')).toBe('Owner'))
  expect(mockListGroups).toHaveBeenNthCalledWith(2, { page: 2, limit: 100 })
})

it('reports a later page failure without granting partial roles and can retry', async () => {
  const firstPage = {
    items: Array.from({ length: 100 }, (_, id) => ({ name: `space-${id}`, my_role: 'Owner' })),
    total: 101,
  }
  mockListGroups
    .mockResolvedValueOnce(firstPage)
    .mockRejectedValueOnce(new Error('second page failed'))
  const { result } = renderHook(() => useNamespaceRoleState())
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.roleMap.size).toBe(0)
  expect(result.current.loading).toBe(false)
  mockListGroups.mockResolvedValueOnce({
    items: [{ name: 'recovered', my_role: 'Owner' }],
    total: 1,
  })
  await act(async () => result.current.refresh())
  expect(result.current.failed).toBe(false)
  expect(result.current.roleMap.get('recovered')).toBe('Owner')
})
