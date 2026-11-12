// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react'
import { act, renderHook } from '@testing-library/react'
import {
  useTeamEditExtension,
  type UseTeamEditExtensionOptions,
} from '@/features/tasks/hooks/useTeamEditExtension'
import type { Bot } from '@/types/api'

function createOptions(): UseTeamEditExtensionOptions {
  return {
    currentTeamId: 1,
    currentTeamNamespace: 'default',
    userId: 1,
    deps: {
      getGroupRoleMap: () => new Map(),
      checkCanEdit: () => true,
      fetchBots: jest.fn(),
      createDialogComponent: jest.fn(() => <div />),
    },
    onTeamUpdated: jest.fn(),
  }
}

describe('useTeamEditExtension', () => {
  it('does not create the edit dialog while it is closed', () => {
    const createDialogComponent = jest.fn(() => <div data-testid="team-edit-dialog" />)

    const { result } = renderHook(() =>
      useTeamEditExtension({
        currentTeamId: 1,
        currentTeamNamespace: 'default',
        userId: 1,
        deps: {
          getGroupRoleMap: () => new Map(),
          checkCanEdit: () => true,
          fetchBots: jest.fn(),
          createDialogComponent,
        },
        onTeamUpdated: jest.fn(),
      })
    )

    expect(result.current?.renderDialog()).toBeNull()
    expect(createDialogComponent).not.toHaveBeenCalled()
  })

  it('publishes only the latest overlapping catalog request', async () => {
    let resolveOld!: (bots: Bot[]) => void
    const options = createOptions()
    ;(options.deps.fetchBots as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise<Bot[]>(resolve => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce([{ id: 1, name: 'current-bot' }])
    const { result } = renderHook(() => useTeamEditExtension(options))
    let oldRequest!: Promise<void>
    act(() => {
      oldRequest = Promise.resolve(result.current!.onEdit())
    })
    await act(async () => {
      await result.current!.onEdit()
    })
    await act(async () => {
      resolveOld([{ id: 1, name: 'obsolete-bot' } as Bot])
      await oldRequest
    })
    result.current!.renderDialog()
    expect(options.deps.createDialogComponent).toHaveBeenLastCalledWith(
      expect.objectContaining({ bots: [expect.objectContaining({ name: 'current-bot' })] })
    )
  })

  it('does not reopen the dialog when a pending refresh resolves after closing', async () => {
    let resolveOld!: (bots: Bot[]) => void
    const options = createOptions()
    ;(options.deps.fetchBots as jest.Mock).mockResolvedValueOnce([]).mockImplementationOnce(
      () =>
        new Promise<Bot[]>(resolve => {
          resolveOld = resolve
        })
    )
    const { result } = renderHook(() => useTeamEditExtension(options))
    await act(async () => {
      await result.current!.onEdit()
    })
    result.current!.renderDialog()
    const { onClose } = (options.deps.createDialogComponent as jest.Mock).mock.calls[0][0]
    let oldRequest!: Promise<void>
    act(() => {
      oldRequest = Promise.resolve(result.current!.onEdit())
    })
    act(() => onClose())
    await act(async () => {
      resolveOld([{ id: 1, name: 'obsolete-bot' } as Bot])
      await oldRequest
    })
    expect(result.current!.renderDialog()).toBeNull()
    expect(options.onTeamUpdated).toHaveBeenCalledTimes(1)
  })

  it.each([{ currentTeamId: 2 }, { currentTeamNamespace: 'platform' }, { userId: 2 }])(
    'invalidates pending requests after context changes: %j',
    async changes => {
      let resolveOld!: (bots: Bot[]) => void
      const options = createOptions()
      ;(options.deps.fetchBots as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<Bot[]>(resolve => {
            resolveOld = resolve
          })
      )
      const { result, rerender } = renderHook(props => useTeamEditExtension(props), {
        initialProps: options,
      })
      let oldRequest!: Promise<void>
      act(() => {
        oldRequest = Promise.resolve(result.current!.onEdit())
      })
      rerender({ ...options, ...changes })
      await act(async () => {
        resolveOld([{ id: 1, name: 'obsolete-bot' } as Bot])
        await oldRequest
      })
      expect(result.current!.renderDialog()).toBeNull()
    }
  )

  it('hides an existing dialog when the selected team changes', async () => {
    const options = createOptions()
    ;(options.deps.fetchBots as jest.Mock).mockResolvedValue([])
    const { result, rerender } = renderHook(props => useTeamEditExtension(props), {
      initialProps: options,
    })
    await act(async () => {
      await result.current!.onEdit()
    })
    rerender({ ...options, currentTeamId: 2 })
    expect(result.current!.renderDialog()).toBeNull()
    rerender(options)
    expect(result.current!.renderDialog()).toBeNull()
  })

  it('invalidates a pending request when edit permission is revoked', async () => {
    let resolveOld!: (bots: Bot[]) => void
    const options = createOptions()
    ;(options.deps.fetchBots as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<Bot[]>(resolve => {
          resolveOld = resolve
        })
    )
    const { result, rerender } = renderHook(props => useTeamEditExtension(props), {
      initialProps: options,
    })
    let oldRequest!: Promise<void>
    act(() => {
      oldRequest = Promise.resolve(result.current!.onEdit())
    })
    rerender({ ...options, deps: { ...options.deps, checkCanEdit: () => false } })
    expect(result.current).toBeUndefined()
    await act(async () => {
      resolveOld([{ id: 1, name: 'obsolete-bot' } as Bot])
      await oldRequest
    })
    rerender(options)
    expect(result.current!.renderDialog()).toBeNull()
  })

  it('propagates an active catalog failure without opening the dialog', async () => {
    const options = createOptions()
    const cause = new Error('Catalog request failed')
    ;(options.deps.fetchBots as jest.Mock).mockRejectedValue(cause)
    const { result } = renderHook(() => useTeamEditExtension(options))
    await act(async () => {
      await expect(result.current!.onEdit()).rejects.toBe(cause)
    })
    expect(result.current!.renderDialog()).toBeNull()
  })
})
