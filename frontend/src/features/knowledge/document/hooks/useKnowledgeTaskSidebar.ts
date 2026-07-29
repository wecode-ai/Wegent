// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceTaskSidebar } from './useWorkspaceTaskSidebar'

const TASK_SIDEBAR_COLLAPSED_KEY = 'task-sidebar-collapsed'

interface UseKnowledgeTaskSidebarOptions {
  isMobile: boolean
  isWorkspaceView: boolean
}

export function useKnowledgeTaskSidebar({
  isMobile,
  isWorkspaceView,
}: UseKnowledgeTaskSidebarOptions) {
  const [userCollapsed, setUserCollapsed] = useState(false)

  useEffect(() => {
    setUserCollapsed(localStorage.getItem(TASK_SIDEBAR_COLLAPSED_KEY) === 'true')
  }, [])

  const toggleUserCollapsed = useCallback(() => {
    setUserCollapsed(previous => {
      const next = !previous
      localStorage.setItem(TASK_SIDEBAR_COLLAPSED_KEY, String(next))
      return next
    })
  }, [])

  return useWorkspaceTaskSidebar({
    isMobile,
    isWorkspaceView,
    userCollapsed,
    onToggleUserCollapsed: toggleUserCollapsed,
  })
}
