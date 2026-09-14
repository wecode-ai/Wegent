// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from 'react'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import type { TeamListResponse } from '@/apis/team'
import { sortTeamsByUpdatedAt } from '@/utils/team'

/** Delays between automatic retries of the team list request, in milliseconds. */
export const TEAM_FETCH_RETRY_DELAYS_MS = [500, 1500]

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const fetchTeams = async (): Promise<Team[]> => {
  const response = await teamApis.getTeams({ page: 1, limit: 100 }, 'all')
  const items = Array.isArray(response.items) ? response.items : []
  return sortTeamsByUpdatedAt(items)
}

export interface UseTeamsResult {
  teams: Team[]
  isTeamsLoading: boolean
  /** True when the latest load failed and no cached team list is available. */
  isTeamsError: boolean
  refreshTeams: () => Promise<Team[]>
  addTeam: (team: Team) => void
}

/**
 * Service for team related business logic
 */
export const teamService = {
  /**
   * Get team list
   */
  async getTeams(): Promise<TeamListResponse> {
    return teamApis.getTeams({ page: 1, limit: 100 }, 'all')
  },

  /**
   * Fetch the accessible team list, retrying transient failures with backoff.
   * A single failed request must never surface as "no agents available".
   */
  async fetchTeamsWithRetry(): Promise<Team[]> {
    let lastError: unknown

    for (let attempt = 0; attempt <= TEAM_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await fetchTeams()
      } catch (error) {
        lastError = error
        const retryDelay = TEAM_FETCH_RETRY_DELAYS_MS[attempt]
        if (retryDelay === undefined) {
          break
        }
        await sleep(retryDelay)
      }
    }

    throw lastError
  },

  /**
   * React hook: Get team related status
   */
  useTeams(): UseTeamsResult {
    const [teams, setTeams] = useState<Team[]>([])
    const [isTeamsLoading, setIsTeamsLoading] = useState(true)
    const [isTeamsError, setIsTeamsError] = useState(false)

    const refreshTeams = useCallback(async (): Promise<Team[]> => {
      setIsTeamsLoading(true)
      try {
        const sortedTeams = await teamService.fetchTeamsWithRetry()
        setTeams(sortedTeams)
        setIsTeamsError(false)
        return sortedTeams
      } catch (error) {
        console.error('[teamService] Failed to fetch teams:', error)
        // Keep the previously loaded teams so a transient failure does not
        // replace a usable list with the "no agents" empty state.
        setIsTeamsError(true)
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

    useEffect(() => {
      void refreshTeams().catch(() => {
        // Failure is surfaced through isTeamsError.
      })
    }, [refreshTeams])

    return {
      teams,
      isTeamsLoading,
      isTeamsError,
      refreshTeams,
      addTeam,
    }
  },
}
