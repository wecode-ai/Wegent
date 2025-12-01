// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { teamApis, TeamShareResponse, CreateTeamRequest } from '@/apis/team';
import { Team } from '@/types/api';

/**
 * Get team list
 */
export async function fetchTeamsList(): Promise<Team[]> {
  const teamsData = await teamApis.getTeams();
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

/**
 * Toggle team favorite status
 */
export async function toggleTeamFavorite(
  teamId: number,
  isFavorited: boolean
): Promise<{ message: string; is_favorited: boolean }> {
  if (isFavorited) {
    return await teamApis.removeTeamFromFavorites(teamId);
  } else {
    return await teamApis.addTeamToFavorites(teamId);
  }
}
