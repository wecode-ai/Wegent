// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from 'react'
import { teamApis } from '@/apis/team'
import type { Team } from '@/types/api'
import type { TeamListResponse } from '@/apis/team'

/**
 * Service for team related business logic
 */
export const teamService = {
  /**
   * 获取团队列表
   */
  async getTeams(): Promise<TeamListResponse> {
    return teamApis.getTeams()
  },

  /**
   * React hook: 获取团队相关状态
   */
  useTeams() {
    const [teams, setTeams] = useState<Team[]>([])
    const [isTeamsLoading, setIsTeamsLoading] = useState(true)

    useEffect(() => {
      setIsTeamsLoading(true)
      teamApis.getTeams()
        .then(res => {
          setTeams(Array.isArray(res.items) ? res.items : [])
        })
        .catch(() => {
          setTeams([])
        })
        .finally(() => setIsTeamsLoading(false))
    }, [])

    return {
      teams,
      isTeamsLoading,
    }
  }
}