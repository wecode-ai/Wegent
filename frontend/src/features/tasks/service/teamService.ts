// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from 'react'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import type { TeamListResponse } from '@/apis/team'
import { sortTeamsByUpdatedAt } from '@/utils/team'

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
   * React hook: Get team related status
   */
  useTeams() {
    const [teams, setTeams] = useState<Team[]>([])
    const [isTeamsLoading, setIsTeamsLoading] = useState(true)

    const refreshTeams = async () => {
      setIsTeamsLoading(true)
      try {
        const res = await teamApis.getTeams({ page: 1, limit: 100 }, 'all')
        const items = Array.isArray(res.items) ? res.items : []
        setTeams(sortTeamsByUpdatedAt(items))
        return items
      } catch (error) {
        setTeams([])
        throw error
      } finally {
        setIsTeamsLoading(false)
      }
    }

    const addTeam = (newTeam: Team) => {
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
    }

    useEffect(() => {
      refreshTeams()
    }, [])

    return {
      teams,
      isTeamsLoading,
      refreshTeams,
      addTeam,
    }
  },
}
