// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useTeamSelection Hook
 *
 * Centralized hook for managing all team selection logic including:
 * - Team list filtering by bind_mode (chat/code)
 * - Team preference restoration (initial load, mode switch, task switch)
 * - Team preference saving (localStorage persistence)
 * - Compatibility checking
 * - Synchronization with task detail
 *
 * This hook extracts business logic from TeamSelector component,
 * making it a pure UI component and eliminating race conditions.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import type { Team, TaskDetail } from '@/types/api'
import { getLastTeamIdByMode, saveLastTeamByMode } from '@/utils/userPreferences'

// ============================================================================
// Types
// ============================================================================

/** Options for useTeamSelection hook */
export interface UseTeamSelectionOptions {
  /** List of all available teams */
  teams: Team[]
  /** Current mode for filtering teams by bind_mode */
  currentMode: 'chat' | 'code'
  /** Currently selected task detail (null for new chat) */
  selectedTaskDetail: TaskDetail | null
  /** Whether there are messages to display (affects preference restoration) */
  hasMessages: boolean
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Clear version from chat stream context (detects "New Chat" action) */
  clearVersion?: number
}

/** Return type for useTeamSelection hook */
export interface UseTeamSelectionReturn {
  // State
  selectedTeam: Team | null
  filteredTeams: Team[]
  isLoading: boolean
  hasRestoredPreferences: boolean

  // Actions
  selectTeam: (team: Team | null, isUserAction?: boolean) => void
  refreshTeams: () => void

  // Helper functions
  isTeamCompatibleWithMode: (team: Team) => boolean
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts the team ID from a task detail's team field.
 * Handles both number and object formats.
 */
function extractTeamId(team: TaskDetail['team']): number | null {
  if (!team) return null
  if (typeof team === 'number') return team
  if (typeof team === 'object') {
    const maybeId = (team as { id?: number }).id
    return typeof maybeId === 'number' ? maybeId : null
  }
  return null
}

/**
 * Extracts the full Team object from task detail's team field.
 */
function extractTeamObject(team: TaskDetail['team']): Team | null {
  if (!team) return null
  if (typeof team === 'object' && 'id' in team) {
    return team as Team
  }
  return null
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useTeamSelection({
  teams,
  currentMode,
  selectedTaskDetail,
  hasMessages,
  disabled: _disabled = false,
  clearVersion = 0,
}: UseTeamSelectionOptions): UseTeamSelectionReturn {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null)
  const [hasRestoredPreferences, setHasRestoredPreferences] = useState(false)
  const [isLoading] = useState(false)

  // -------------------------------------------------------------------------
  // Refs for tracking state changes
  // -------------------------------------------------------------------------
  const prevClearVersionRef = useRef(clearVersion)
  const prevTaskIdRef = useRef<number | null>(null)
  const prevModeRef = useRef<'chat' | 'code'>(currentMode)
  const hasInitializedRef = useRef(false)
  const isRestoringRef = useRef(false)
  const initialTeamIdRef = useRef<number | null>(null)
  const userManuallySelectedRef = useRef(false) // Track if user manually selected a team
  const justClearedRef = useRef(false) // Track if clearVersion just changed

  // -------------------------------------------------------------------------
  // Get initial team preference from localStorage (once on mount)
  // -------------------------------------------------------------------------
  if (initialTeamIdRef.current === null && typeof window !== 'undefined') {
    initialTeamIdRef.current = getLastTeamIdByMode(currentMode)
  }

  // -------------------------------------------------------------------------
  // Get taskId from URL
  // -------------------------------------------------------------------------
  const searchParams = useSearchParams()
  const taskIdFromUrl =
    searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')

  // -------------------------------------------------------------------------
  // Derived State: Filter teams by bind_mode
  // -------------------------------------------------------------------------
  const filteredTeams = useMemo(() => {
    // First filter out teams with empty bind_mode array
    const teamsWithValidBindMode = teams.filter(team => {
      // If bind_mode is an empty array, filter it out
      if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
      return true
    })

    return teamsWithValidBindMode.filter(team => {
      // If bind_mode is not set (undefined/null), show in all modes
      if (!team.bind_mode) return true
      // Otherwise, only show if current mode is in bind_mode
      return team.bind_mode.includes(currentMode)
    })
  }, [teams, currentMode])

  // -------------------------------------------------------------------------
  // Helper: Check if a team is compatible with the current mode
  // -------------------------------------------------------------------------
  const isTeamCompatibleWithMode = useCallback(
    (team: Team): boolean => {
      if (!team.bind_mode || team.bind_mode.length === 0) return false
      return team.bind_mode.includes(currentMode)
    },
    [currentMode]
  )

  // -------------------------------------------------------------------------
  // Helper: Find team by ID in filtered list
  // -------------------------------------------------------------------------
  const findTeamById = useCallback(
    (teamId: number | null): Team | null => {
      if (!teamId) return null
      return filteredTeams.find(t => t.id === teamId) || null
    },
    [filteredTeams]
  )

  // -------------------------------------------------------------------------
  // Reset state when clearVersion changes (New Chat action)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (clearVersion !== prevClearVersionRef.current) {
      console.log('[useTeamSelection] Clear version changed, resetting preferences')
      prevClearVersionRef.current = clearVersion
      justClearedRef.current = true // Set flag to prevent immediate Case 3 execution
      setHasRestoredPreferences(false)
      userManuallySelectedRef.current = false // Also reset manual selection flag
    }
  }, [clearVersion])

  // -------------------------------------------------------------------------
  // Main Selection Logic
  // Priority:
  // 1. Sync from task detail when viewing existing task
  // 2. Restore from localStorage when no messages
  // 3. Auto-select first compatible team as fallback
  // -------------------------------------------------------------------------
  useEffect(() => {
    const currentTaskId = selectedTaskDetail?.id ?? null
    const detailTeamId = selectedTaskDetail ? extractTeamId(selectedTaskDetail.team) : null
    const taskChanged = prevTaskIdRef.current !== currentTaskId
    const modeChanged = prevModeRef.current !== currentMode

    console.log('[useTeamSelection] Selection effect triggered', {
      currentTaskId,
      taskIdFromUrl,
      detailTeamId,
      selectedTeamId: selectedTeam?.id ?? null,
      taskChanged,
      modeChanged,
      hasMessages,
      hasRestoredPreferences,
      hasInitialized: hasInitializedRef.current,
      filteredTeamsCount: filteredTeams.length,
    })

    prevTaskIdRef.current = currentTaskId
    prevModeRef.current = currentMode

    // Skip if no teams available
    if (filteredTeams.length === 0) {
      console.log('[useTeamSelection] No filtered teams available')
      setSelectedTeam(null)
      return
    }

    // -----------------------------------------------------------------------
    // Case 1: Task Detail Sync (Highest Priority)
    // When viewing an existing task, ALWAYS sync to task's team
    // This is the SINGLE SOURCE OF TRUTH for existing tasks
    // -----------------------------------------------------------------------
    if (currentTaskId && detailTeamId && taskIdFromUrl) {
      // CRITICAL: Only sync if the taskId in URL matches the current task detail
      // This prevents race conditions when task detail hasn't loaded yet
      if (currentTaskId.toString() === taskIdFromUrl) {
        console.log('[useTeamSelection] Case 1: Syncing from task detail', {
          detailTeamId,
          currentSelectedId: selectedTeam?.id,
        })

        // Only update if team is different
        if (!selectedTeam || selectedTeam.id !== detailTeamId) {
          const matchedTeam = findTeamById(detailTeamId)
          if (matchedTeam) {
            console.log('[useTeamSelection] Case 1: Setting team from detail:', matchedTeam.name)
            isRestoringRef.current = true
            setSelectedTeam(matchedTeam)
            setHasRestoredPreferences(true)
            hasInitializedRef.current = true
            userManuallySelectedRef.current = false // Clear manual selection flag
            setTimeout(() => {
              isRestoringRef.current = false
            }, 100)
            return
          } else {
            // Team from detail not found in filtered list, try using team object from detail
            if (selectedTaskDetail) {
              const teamObject = extractTeamObject(selectedTaskDetail.team)
              if (teamObject && teamObject.id === detailTeamId) {
                console.log(
                  '[useTeamSelection] Case 1: Using team object from detail:',
                  teamObject.name
                )
                isRestoringRef.current = true
                setSelectedTeam(teamObject)
                setHasRestoredPreferences(true)
                hasInitializedRef.current = true
                userManuallySelectedRef.current = false // Clear manual selection flag
                setTimeout(() => {
                  isRestoringRef.current = false
                }, 100)
                return
              }
            }
          }
        } else {
          // Team already correct, just ensure preferences are marked as restored
          if (!hasRestoredPreferences) {
            setHasRestoredPreferences(true)
            hasInitializedRef.current = true
          }
          return
        }
      } else {
        // Task detail doesn't match URL yet - waiting for correct task to load
        console.log('[useTeamSelection] Waiting for task detail to load', {
          currentTaskId,
          taskIdFromUrl,
        })
        // Don't restore from localStorage yet - wait for task detail
        return
      }
    }

    // -----------------------------------------------------------------------
    // Case 2: Mode Changed - Validate and Re-select
    // When mode changes, check if current team is still compatible
    // -----------------------------------------------------------------------
    if (modeChanged && hasInitializedRef.current) {
      console.log('[useTeamSelection] Case 2: Mode changed', {
        currentMode,
        selectedTeamId: selectedTeam?.id,
      })

      if (selectedTeam) {
        const isStillCompatible = filteredTeams.some(t => t.id === selectedTeam.id)
        if (isStillCompatible) {
          console.log('[useTeamSelection] Case 2: Current team still compatible')
          return
        } else {
          console.log('[useTeamSelection] Case 2: Current team no longer compatible, will restore')
          // Fall through to restore from localStorage
        }
      }
    }

    // -----------------------------------------------------------------------
    // Case 3: Initial Load or Preference Restoration
    // Restore from localStorage when:
    // - First load (!hasInitialized)
    // - No messages (new chat)
    // - Mode changed and current team not compatible
    // - Task changed and no task detail available
    // Skip if user manually selected a team (respect user's explicit choice)
    // Skip if clearVersion just changed (allow hasRestoredPreferences to stay false)
    // -----------------------------------------------------------------------
    if (justClearedRef.current) {
      // Skip Case 3 on the first render after clearVersion changes
      // Reset the flag for next render
      justClearedRef.current = false
      console.log('[useTeamSelection] Skipping Case 3 due to recent clearVersion change')
      return
    }

    if (
      !userManuallySelectedRef.current &&
      (!hasRestoredPreferences ||
        (!hasMessages && !currentTaskId) ||
        (modeChanged && !selectedTeam) ||
        (taskChanged && !currentTaskId))
    ) {
      console.log('[useTeamSelection] Case 3: Restoring from localStorage', {
        hasRestoredPreferences,
        hasMessages,
        currentTaskId,
        modeChanged,
        taskChanged,
      })

      isRestoringRef.current = true
      const lastTeamId = initialTeamIdRef.current

      if (lastTeamId) {
        const lastTeam = findTeamById(lastTeamId)
        if (lastTeam) {
          console.log('[useTeamSelection] Case 3: Restored from localStorage:', lastTeam.name)
          setSelectedTeam(lastTeam)
          setHasRestoredPreferences(true)
          hasInitializedRef.current = true
          setTimeout(() => {
            isRestoringRef.current = false
          }, 100)
          return
        }
      }

      // Fallback: Select first compatible team
      const firstCompatibleTeam = filteredTeams[0] || null
      if (firstCompatibleTeam) {
        console.log(
          '[useTeamSelection] Case 3: No localStorage preference, selecting first team:',
          firstCompatibleTeam.name
        )
        setSelectedTeam(firstCompatibleTeam)
      } else {
        console.log('[useTeamSelection] Case 3: No teams available')
        // Clear selection if no teams available
        setSelectedTeam(null)
      }
      // Always mark as restored to prevent infinite re-execution
      // Even if no team is selected, we've attempted restoration
      setHasRestoredPreferences(true)
      hasInitializedRef.current = true
      setTimeout(() => {
        isRestoringRef.current = false
      }, 100)
      return
    }

    // -----------------------------------------------------------------------
    // Case 4: Validate Current Selection
    // Ensure selected team still exists in filtered list
    // Skip if user manually selected (respect user's explicit choice)
    // -----------------------------------------------------------------------
    if (selectedTeam && hasInitializedRef.current && !userManuallySelectedRef.current) {
      const exists = filteredTeams.some(t => t.id === selectedTeam.id)
      if (!exists) {
        console.log('[useTeamSelection] Case 4: Selected team no longer in filtered list')
        const firstCompatibleTeam = filteredTeams[0] || null
        if (firstCompatibleTeam) {
          console.log(
            '[useTeamSelection] Case 4: Auto-selecting first team:',
            firstCompatibleTeam.name
          )
          setSelectedTeam(firstCompatibleTeam)
        } else {
          setSelectedTeam(null)
        }
      }
    }
  }, [
    filteredTeams,
    currentMode,
    selectedTaskDetail,
    taskIdFromUrl,
    hasMessages,
    hasRestoredPreferences,
    selectedTeam,
    findTeamById,
  ])

  // -------------------------------------------------------------------------
  // Save Team Preference to localStorage
  // Only save when user manually selects a team (not during restore)
  // -------------------------------------------------------------------------
  useEffect(() => {
    // Skip if not initialized yet
    if (!hasInitializedRef.current) {
      return
    }

    // Skip during restore
    if (isRestoringRef.current) {
      return
    }

    // Only save user-initiated selections
    if (!userManuallySelectedRef.current) {
      return
    }

    if (selectedTeam && selectedTeam.id) {
      console.log('[useTeamSelection] Saving team preference to localStorage', {
        teamId: selectedTeam.id,
        teamName: selectedTeam.name,
        mode: currentMode,
      })
      saveLastTeamByMode(selectedTeam.id, currentMode)
      // Update ref so next mount can use this value
      initialTeamIdRef.current = selectedTeam.id
    }
  }, [selectedTeam, currentMode])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Select a team directly (typically called by user interaction) */
  const selectTeam = useCallback(
    (team: Team | null, isUserAction = true) => {
      console.log('[useTeamSelection] selectTeam called:', {
        team: team?.name || 'null',
        isUserAction,
      })
      if (isUserAction) {
        userManuallySelectedRef.current = true
        // Save to localStorage immediately for user actions
        if (team && team.id) {
          console.log('[useTeamSelection] Saving team preference (from selectTeam):', {
            teamId: team.id,
            teamName: team.name,
            mode: currentMode,
          })
          saveLastTeamByMode(team.id, currentMode)
          initialTeamIdRef.current = team.id
        }
      }
      setSelectedTeam(team)
      // Mark as initialized and restored since user made an explicit choice
      hasInitializedRef.current = true
      setHasRestoredPreferences(true)
    },
    [currentMode]
  )

  /** Refresh teams (placeholder for future use) */
  const refreshTeams = useCallback(() => {
    console.log('[useTeamSelection] refreshTeams called')
    // Teams are managed externally, this is a placeholder for consistency
  }, [])

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  return {
    // State
    selectedTeam,
    filteredTeams,
    isLoading,
    hasRestoredPreferences,

    // Actions
    selectTeam,
    refreshTeams,

    // Helpers
    isTeamCompatibleWithMode,
  }
}

export default useTeamSelection
