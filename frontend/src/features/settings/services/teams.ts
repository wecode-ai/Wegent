// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { teamApis, TeamShareResponse, CreateTeamRequest } from '@/apis/team'
import { CheckRunningTasksResponse } from '@/apis/common'
import { Team } from '@/types/api'

/**
 * Get team list
 * @param scope - Resource scope: 'personal', 'group', or 'all'
 * @param groupName - Group name (required when scope is 'group')
 */
export async function fetchTeamsList(
  scope?: 'personal' | 'group' | 'all',
  groupName?: string
): Promise<Team[]> {
  const teamsData = await teamApis.getTeams(undefined, scope, groupName)
  return Array.isArray(teamsData.items) ? teamsData.items : []
}

/**
 * Create team
 */
export async function createTeam(teamData: CreateTeamRequest): Promise<Team> {
  return await teamApis.createTeam(teamData)
}

/**
 * Delete team
 * @param teamId - Team ID
 * @param force - Force delete even if team has running tasks
 */
export async function deleteTeam(teamId: number, force: boolean = false): Promise<void> {
  await teamApis.deleteTeam(teamId, force)
}

/**
 * Edit team
 */
export async function updateTeam(teamId: number, teamData: CreateTeamRequest): Promise<Team> {
  return await teamApis.updateTeam(teamId, teamData)
}

/**
 * Share team
 */
export async function shareTeam(teamId: number): Promise<TeamShareResponse> {
  return await teamApis.shareTeam(teamId)
}

/**
 * Check if team has running tasks
 * @param teamId - Team ID
 * @returns Running tasks info
 */
export async function checkTeamRunningTasks(teamId: number): Promise<CheckRunningTasksResponse> {
  return await teamApis.checkRunningTasks(teamId)
}
