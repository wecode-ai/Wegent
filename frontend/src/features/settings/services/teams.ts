// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { teamApis, TeamShareResponse, CreateTeamRequest } from '@/apis/team';
import { Team } from '@/types/api';

/**
 * Get team list
 * @param scope - Resource scope: 'personal', 'group', or 'all'
 * @param groupName - Group name (required when scope is 'group')
 */
export async function fetchTeamsList(
  scope?: 'personal' | 'group' | 'all',
  groupName?: string
): Promise<Team[]> {
  const teamsData = await teamApis.getTeams(undefined, scope, groupName);
  return Array.isArray(teamsData.items) ? teamsData.items : [];
}

/**
 * Create team
 */
export async function createTeam(teamData: CreateTeamRequest): Promise<Team> {
  return await teamApis.createTeam(teamData);
}

/**
 * Delete team
 */
export async function deleteTeam(teamId: number): Promise<void> {
  await teamApis.deleteTeam(teamId);
}

/**
 * Edit team
 */
export async function updateTeam(teamId: number, teamData: CreateTeamRequest): Promise<Team> {
  return await teamApis.updateTeam(teamId, teamData);
}

/**
 * Share team
 */
export async function shareTeam(teamId: number): Promise<TeamShareResponse> {
  return await teamApis.shareTeam(teamId);
}
