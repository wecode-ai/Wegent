// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Team Context Provider
 *
 * Provides centralized team state management to avoid duplicate API calls.
 * All components that need team data should use useTeamContext() instead of
 * calling teamService.useTeams() directly.
 *
 * This solves the problem of multiple components (ChatPage, ChatPageDesktop,
 * ChatPageMobile, CreateGroupChatDialog, etc.) each making their own API calls
 * to fetch the same team data.
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from 'react'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import { sortTeamsByUpdatedAt } from '@/utils/team'

interface TeamContextType {
  /** List of teams */
  teams: Team[]
  /** Whether teams are currently loading */
  isTeamsLoading: boolean
  /** Refresh teams from API */
  refreshTeams: () => Promise<Team[]>
  /** Add a new team to the list (optimistic update) */
  addTeam: (team: Team) => void
}

const TeamContext = createContext<TeamContextType | undefined>(undefined)

export function TeamProvider({ children }: { children: ReactNode }) {
  const [teams, setTeams] = useState<Team[]>([])
  const [isTeamsLoading, setIsTeamsLoading] = useState(true)

  const refreshTeams = useCallback(async (): Promise<Team[]> => {
    setIsTeamsLoading(true)
    try {
      const res = await teamApis.getTeams({ page: 1, limit: 100 }, 'all')
      const items = Array.isArray(res.items) ? res.items : []
      const sortedTeams = sortTeamsByUpdatedAt(items)
      setTeams(sortedTeams)
      return sortedTeams
    } catch (error) {
      console.error('[TeamContext] Failed to fetch teams:', error)
      setTeams([])
      throw error
    } finally {
      setIsTeamsLoading(false)
    }
  }, [])

  const addTeam = useCallback((newTeam: Team) => {
    setTeams(prevTeams => {
      // Check if team already exists
      const exists = prevTeams.some(team => team.id === newTeam.id)
      if (exists) {
        return prevTeams
      }
      // Add new team and re-sort
      const updatedTeams = [...prevTeams, newTeam]
      return sortTeamsByUpdatedAt(updatedTeams)
    })
  }, [])

  // Fetch teams on mount
  useEffect(() => {
    refreshTeams().catch(() => {
      // Error already logged in refreshTeams
    })
  }, [refreshTeams])

  return (
    <TeamContext.Provider
      value={{
        teams,
        isTeamsLoading,
        refreshTeams,
        addTeam,
      }}
    >
      {children}
    </TeamContext.Provider>
  )
}

/**
 * Hook to access team context
 *
 * @throws Error if used outside of TeamProvider
 */
export function useTeamContext(): TeamContextType {
  const context = useContext(TeamContext)
  if (!context) {
    throw new Error('useTeamContext must be used within a TeamProvider')
  }
  return context
}
