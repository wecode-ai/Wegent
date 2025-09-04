// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { teamApis } from '@/apis/team'
import { Team } from '@/types/api'

/**
 * Get team list
 */
export async function fetchTeamsList(): Promise<Team[]> {
  const teamsData = await teamApis.getTeams()
  return Array.isArray(teamsData.items) ? teamsData.items : []
}

/**
 * Create team
 */
export async function createTeam(teamData: any): Promise<Team> {
  return await teamApis.createTeam(teamData)
}

/**
 * Delete team
 */
export async function deleteTeam(teamId: number): Promise<void> {
  await teamApis.deleteTeam(teamId)
}

/**
 * Edit team
 */
export async function updateTeam(teamId: number, teamData: any): Promise<Team> {
  return await teamApis.updateTeam(teamId, teamData)
}