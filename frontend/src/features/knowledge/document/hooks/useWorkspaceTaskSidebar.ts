// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useState } from 'react'

interface UseWorkspaceTaskSidebarOptions {
  isMobile: boolean
  isWorkspaceView: boolean
  userCollapsed: boolean
  onToggleUserCollapsed: () => void
}

export function useWorkspaceTaskSidebar({
  isMobile,
  isWorkspaceView,
  userCollapsed,
  onToggleUserCollapsed,
}: UseWorkspaceTaskSidebarOptions) {
  const [isWorkspaceExpanded, setIsWorkspaceExpanded] = useState(false)
  const usesWorkspaceFocusMode = !isMobile && isWorkspaceView

  useEffect(() => {
    if (!usesWorkspaceFocusMode) {
      setIsWorkspaceExpanded(false)
    }
  }, [usesWorkspaceFocusMode])

  const toggle = useCallback(() => {
    if (usesWorkspaceFocusMode) {
      setIsWorkspaceExpanded(current => !current)
      return
    }
    onToggleUserCollapsed()
  }, [onToggleUserCollapsed, usesWorkspaceFocusMode])

  return {
    isCollapsed: usesWorkspaceFocusMode ? !isWorkspaceExpanded : userCollapsed,
    toggle,
  }
}
