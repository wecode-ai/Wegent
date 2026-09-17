// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  teamApis,
  TeamShareResponse,
  CreateTeamRequest,
  TeamIdentityConfirmation,
} from '@/apis/team'
import { CheckRunningTasksResponse } from '@/apis/common'
import { Team } from '@/types/api'
import { resourceLibraryApi } from '@/apis/resourceLibrary'

type ManagedTeamFilters = Omit<
  Parameters<typeof resourceLibraryApi.searchResources>[0],
  'resourceType' | 'limit' | 'cursor' | 'ownedOnly'
>
export type ManagedTeamsNextPage = { page: number } | { cursor: string }

/** Browse by page number; use the search endpoint only for nonempty keywords. */
export async function fetchManagedTeamsPage(
  params: ManagedTeamFilters & { page?: number; cursor?: string },
  signal?: AbortSignal
): Promise<{ items: Team[]; next: ManagedTeamsNextPage | null }> {
  const keyword = params.keyword.trim()
  if (keyword) {
    const result = await resourceLibraryApi.searchResources(
      { ...params, keyword, resourceType: 'agent', limit: 100 },
      signal
    )
    return {
      items: result.items,
      next: result.next_cursor ? { cursor: result.next_cursor } : null,
    }
  }
  const page = params.page ?? 1
  const result = await teamApis.getTeams(
    {
      page,
      limit: 100,
      groupNames: params.groupNames,
      sourceFilter: params.sourceFilter,
      mode: params.mode,
    },
    params.scope,
    params.groupName,
    { signal }
  )
  return { items: result.items, next: page * 100 < result.total ? { page: page + 1 } : null }
}

/** Get the full catalog only for consumers that explicitly need every agent. */
export async function fetchTeamsList(
  scope?: 'personal' | 'group' | 'all',
  groupName?: string
): Promise<Team[]> {
  return (await teamApis.getAllTeams(scope, groupName)).items
}

/**
 * Create team
 */
export async function createTeam(teamData: CreateTeamRequest): Promise<Team> {
  return await teamApis.createTeam(teamData)
}

/**
 * Copy team
 * @param id - Team ID to copy
 * @param targetNamespace - Target namespace ('default' for personal, group name for group). Defaults to same namespace.
 * @param copySkills - Whether to copy personal skills to the target namespace
 */
export async function copyTeam(
  id: number,
  targetNamespace?: string,
  copySkills?: boolean
): Promise<Team> {
  return await teamApis.copyTeam(id, targetNamespace, copySkills)
}

/**
 * Delete team
 * @param teamId - Team ID
 * @param confirmName - Current name for destructive deletion
 */
export async function deleteTeam(teamId: number, confirmName?: string): Promise<void> {
  await teamApis.deleteTeam(teamId, confirmName)
}

/**
 * Edit team
 */
export async function updateTeam(
  teamId: number,
  teamData: CreateTeamRequest,
  identityConfirmation?: TeamIdentityConfirmation
): Promise<Team> {
  return await teamApis.updateTeam(teamId, teamData, identityConfirmation)
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
