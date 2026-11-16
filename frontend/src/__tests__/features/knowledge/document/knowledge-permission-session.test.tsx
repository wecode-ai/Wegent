// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useKnowledgePermissions } from '@/features/knowledge/permission/hooks/useKnowledgePermissions'
import type { PermissionListResponse } from '@/types/knowledge'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'
let mockUser = { id: 1 }
let mockScope = 'backend:session-1'
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
  knowledgePermissionApi: {
    listPermissions: jest.fn(),
    deletePermission: jest.fn(),
    updatePermission: jest.fn(),
  },
}))

it.each(['user', 'backend', 'session', 'library'])(
  'never publishes old permission reads after %s changes',
  async kind => {
    mockUser = { id: 1 }
    mockScope = 'backend:session-1'
    let finish!: (value: PermissionListResponse) => void
    jest.mocked(knowledgePermissionApi.listPermissions).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const { result, rerender } = renderHook(({ kbId }) => useKnowledgePermissions({ kbId }), {
      initialProps: { kbId: 27 },
    })
    let request!: Promise<void>
    act(() => {
      request = result.current.fetchPermissions()
    })
    if (kind === 'user') mockUser = { id: 2 }
    else if (kind !== 'library') mockScope = kind + ':next'
    rerender({ kbId: kind === 'library' ? 28 : 27 })
    await act(async () => {
      finish({
        pending: [],
        approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
      })
      await request
    })
    expect(result.current.permissions).toBeNull()
    expect(result.current.loading).toBe(false)
  }
)

it('keeps a newer permission read when an older read fails afterward', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  let rejectOld!: (reason: unknown) => void
  jest.mocked(knowledgePermissionApi.listPermissions).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectOld = reject
      })
  )
  const { result } = renderHook(() => useKnowledgePermissions({ kbId: 27 }))
  let first!: Promise<void>
  act(() => {
    first = result.current.fetchPermissions()
  })
  jest.mocked(knowledgePermissionApi.listPermissions).mockResolvedValueOnce({
    pending: [],
    approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
  })
  await act(async () => result.current.fetchPermissions())
  await act(async () => {
    rejectOld(new Error('old failure'))
    await first
  })
  expect(result.current.error).toBeNull()
  expect(result.current.permissions).not.toBeNull()
})

it('does not publish a late mutation or refetch members after the permission session changes', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  let finish!: (value: { message: string }) => void
  jest.mocked(knowledgePermissionApi.deletePermission).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const onChanged = jest.fn()
  const { result, rerender } = renderHook(() => useKnowledgePermissions({ kbId: 27, onChanged }))
  let request!: Promise<void>
  act(() => {
    request = result.current.deletePermission(91)
  })
  const calls = jest.mocked(knowledgePermissionApi.listPermissions).mock.calls.length
  mockScope = 'backend:next-session'
  rerender()
  await act(async () => {
    finish({ message: 'ok' })
    await request
  })
  expect(onChanged).not.toHaveBeenCalled()
  expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledTimes(calls)
  expect(result.current.loading).toBe(false)
})

it('rejects an old A request after the resource scope goes A to B to A', async () => {
  mockUser = { id: 1 }
  mockScope = 'backend:session-1'
  let finish!: (value: PermissionListResponse) => void
  let finishCurrent!: (value: PermissionListResponse) => void
  jest.mocked(knowledgePermissionApi.listPermissions).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const { result, rerender } = renderHook(({ kbId }) => useKnowledgePermissions({ kbId }), {
    initialProps: { kbId: 27 },
  })
  let oldRequest!: Promise<void>, currentRequest!: Promise<void>
  act(() => {
    oldRequest = result.current.fetchPermissions()
  })
  rerender({ kbId: 28 })
  rerender({ kbId: 27 })
  jest.mocked(knowledgePermissionApi.listPermissions).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishCurrent = resolve
      })
  )
  act(() => {
    currentRequest = result.current.fetchPermissions()
  })
  const response = {
    pending: [],
    approved: { Owner: [], Maintainer: [], Developer: [], Reporter: [], RestrictedAnalyst: [] },
  }
  await act(async () => {
    finish(response)
    await oldRequest
  })
  expect(result.current.permissions).toBeNull()
  expect(result.current.loading).toBe(true)
  await act(async () => {
    finishCurrent(response)
    await currentRequest
  })
  expect(result.current.permissions).toEqual(response)
  expect(result.current.loading).toBe(false)
})

it.each(['delete', 'update'])(
  'notifies the live page after the permission UI closes (%s)',
  async kind => {
    mockUser = { id: 1 }
    mockScope = 'backend:session-1'
    let finish!: (value: never) => void
    const operation =
      kind === 'delete'
        ? knowledgePermissionApi.deletePermission
        : knowledgePermissionApi.updatePermission
    jest.mocked(operation).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        }) as never
    )
    const changed = jest.fn()
    const { result, unmount } = renderHook(() =>
      useKnowledgePermissions({ kbId: 27, onChanged: changed })
    )
    let request!: Promise<unknown>
    act(() => {
      request =
        kind === 'delete'
          ? result.current.deletePermission(91)
          : result.current.updatePermission(91, 'Reporter')
    })
    const reads = jest.mocked(knowledgePermissionApi.listPermissions).mock.calls.length
    unmount()
    await act(async () => {
      finish({ message: 'ok' } as never)
      await request
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(knowledgePermissionApi.listPermissions).toHaveBeenCalledTimes(reads)
  }
)

it('does not notify a new cache session after the permission UI closes', async () => {
  mockScope = 'backend:session-1'
  let finish!: (value: { message: string }) => void
  jest.mocked(knowledgePermissionApi.deletePermission).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const changed = jest.fn()
  const { result, unmount } = renderHook(() =>
    useKnowledgePermissions({ kbId: 27, onChanged: changed })
  )
  let request!: Promise<void>
  act(() => {
    request = result.current.deletePermission(91)
  })
  unmount()
  mockScope = 'backend:session-2'
  await act(async () => {
    finish({ message: 'ok' })
    await request
  })
  expect(changed).not.toHaveBeenCalled()
})
