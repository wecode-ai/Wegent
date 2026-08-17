// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from '@testing-library/react'
import { useWorkspaceTaskSidebar } from '@/features/knowledge/document/hooks/useWorkspaceTaskSidebar'

describe('useWorkspaceTaskSidebar', () => {
  it('temporarily collapses the desktop workspace without changing the user preference', () => {
    const onToggleUserCollapsed = jest.fn()
    const { result, rerender } = renderHook(
      ({ isWorkspaceView, userCollapsed }: { isWorkspaceView: boolean; userCollapsed: boolean }) =>
        useWorkspaceTaskSidebar({
          isMobile: false,
          isWorkspaceView,
          userCollapsed,
          onToggleUserCollapsed,
        }),
      {
        initialProps: {
          isWorkspaceView: true,
          userCollapsed: false,
        },
      }
    )

    expect(result.current.isCollapsed).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.isCollapsed).toBe(false)
    expect(onToggleUserCollapsed).not.toHaveBeenCalled()

    rerender({ isWorkspaceView: false, userCollapsed: false })
    expect(result.current.isCollapsed).toBe(false)

    rerender({ isWorkspaceView: true, userCollapsed: false })
    expect(result.current.isCollapsed).toBe(true)
  })

  it('uses the persisted toggle outside desktop workspace focus mode', () => {
    const onToggleUserCollapsed = jest.fn()
    const { result } = renderHook(() =>
      useWorkspaceTaskSidebar({
        isMobile: true,
        isWorkspaceView: true,
        userCollapsed: false,
        onToggleUserCollapsed,
      })
    )

    expect(result.current.isCollapsed).toBe(false)
    act(() => result.current.toggle())
    expect(onToggleUserCollapsed).toHaveBeenCalledTimes(1)
  })
})
