// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback, useMemo } from 'react'
import type { Bot } from '@/types/api'
import type { BaseRole } from '@/types/base-role'
import type { ChatAreaTeamEditExtension } from '../components/chat/types'
import React from 'react'

/**
 * Dependencies required by useTeamEditExtension
 * These are injected from the parent component to avoid direct module dependencies
 */
export interface UseTeamEditExtensionDeps {
  /** Get the current group role map */
  getGroupRoleMap: () => Map<string, BaseRole>
  /** Check if user can edit a team */
  checkCanEdit: (teamId: number, userId: number, roleMap: Map<string, BaseRole>) => boolean
  /** Fetch bots list for the given scope */
  fetchBots: (scope: 'personal' | 'group', groupName?: string) => Promise<Bot[]>
  /** Create the team edit dialog component */
  createDialogComponent: (props: {
    open: boolean
    onClose: () => void
    bots: Bot[]
  }) => React.ReactNode
}

/**
 * Options for useTeamEditExtension hook
 */
export interface UseTeamEditExtensionOptions {
  /** Current team ID */
  currentTeamId: number | null
  /** Current team namespace (for group teams) */
  currentTeamNamespace?: string | null
  /** Current user ID */
  userId: number | undefined
  /** Dependencies injected from parent */
  deps: UseTeamEditExtensionDeps
  /** Callback when team is updated */
  onTeamUpdated: () => void
}

/**
 * Hook to manage team edit extension state and logic
 *
 * This hook encapsulates all team editing logic while remaining decoupled
 * from the settings module. Dependencies are injected via the deps parameter.
 *
 * @param options - Configuration options and injected dependencies
 * @returns Team edit extension object or undefined if editing is not available
 */
export function useTeamEditExtension(
  options: UseTeamEditExtensionOptions
): ChatAreaTeamEditExtension | undefined {
  const { currentTeamId, currentTeamNamespace, userId, deps, onTeamUpdated } = options

  const [open, setOpen] = useState(false)
  const [bots, setBots] = useState<Bot[]>([])
  const [, setLoading] = useState(false)

  // Compute edit permission
  const canEdit = useMemo(() => {
    if (!currentTeamId || !userId) return false
    const roleMap = deps.getGroupRoleMap()
    return deps.checkCanEdit(currentTeamId, userId, roleMap)
  }, [currentTeamId, userId, deps])

  // Extract deps functions to stable refs
  const { fetchBots } = deps

  const handleOpen = useCallback(async () => {
    if (!currentTeamId || !canEdit) return

    setLoading(true)
    try {
      const scope =
        currentTeamNamespace && currentTeamNamespace !== 'default' ? 'group' : 'personal'
      const groupName = scope === 'group' ? currentTeamNamespace : undefined

      const botList = await fetchBots(scope, groupName ?? undefined)
      setBots(botList)
      setOpen(true)
    } finally {
      setLoading(false)
    }
  }, [currentTeamId, canEdit, currentTeamNamespace, fetchBots])

  const handleClose = useCallback(() => {
    setOpen(false)
    onTeamUpdated()
  }, [onTeamUpdated])

  // Extract createDialogComponent to stable ref
  const { createDialogComponent } = deps

  // Render the dialog with current state
  // NOTE: All hooks must be called before any conditional return
  const renderDialog = useCallback(() => {
    return createDialogComponent({
      open,
      onClose: handleClose,
      bots,
    })
  }, [open, bots, createDialogComponent, handleClose])

  if (!canEdit || !currentTeamId) {
    return undefined
  }

  return {
    canEdit: true,
    onEdit: handleOpen,
    renderDialog,
  }
}
