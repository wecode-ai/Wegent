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

import React, { createContext, useContext, ReactNode } from 'react'
import type { Team } from '@/types/api'
import { teamService } from '@/features/tasks/service/teamService'

interface TeamContextType {
  /** List of teams */
  teams: Team[]
  /** Whether teams are currently loading */
  isTeamsLoading: boolean
  /** Error from the latest failed load, cleared on success */
  loadError: Error | null
  /** Refresh teams from API */
  refreshTeams: () => Promise<Team[]>
  /** Add a new team to the list (optimistic update) */
  addTeam: (team: Team) => void
}

const TeamContext = createContext<TeamContextType | undefined>(undefined)

export function TeamProvider({ children }: { children: ReactNode }) {
  const { teams, isTeamsLoading, loadError, refreshTeams, addTeam } = teamService.useTeams()

  return (
    <TeamContext.Provider
      value={{
        teams,
        isTeamsLoading,
        loadError,
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
