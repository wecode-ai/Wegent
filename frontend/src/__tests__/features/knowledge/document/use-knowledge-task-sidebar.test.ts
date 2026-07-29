// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderHook } from '@testing-library/react'
import { useKnowledgeTaskSidebar } from '@/features/knowledge/document/hooks/useKnowledgeTaskSidebar'

describe('useKnowledgeTaskSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('hydrates the persisted collapsed state before paint', () => {
    localStorage.setItem('task-sidebar-collapsed', 'true')

    const { result } = renderHook(() =>
      useKnowledgeTaskSidebar({
        isMobile: false,
        isWorkspaceView: false,
      })
    )

    expect(result.current.isCollapsed).toBe(true)
  })
})
