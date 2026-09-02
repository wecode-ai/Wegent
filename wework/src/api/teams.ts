import type { Team, TeamExecutionBot, TeamExecutionProfile } from '@/types/api'
import type { HttpClient, HttpRequestOptions } from './http'

interface TeamListResponse {
  total: number
  items: Team[]
}

interface TeamDetailResponse {
  id: number
  name: string
  namespace?: string | null
  bots: TeamExecutionBot[]
  workflow?: { mode?: string } | null
  updated_at: string
}

export function createTeamApi(client: HttpClient) {
  async function listTeams(requestOptions?: Pick<HttpRequestOptions, 'signal'>): Promise<Team[]> {
    const response = requestOptions
      ? await client.get<TeamListResponse>('/teams?page=1&limit=100', requestOptions)
      : await client.get<TeamListResponse>('/teams?page=1&limit=100')
    return response.items
  }

  async function getExecutionProfile(teamId: number): Promise<TeamExecutionProfile> {
    const detail = await client.get<TeamDetailResponse>(`/teams/${teamId}`)
    return {
      id: detail.id,
      name: detail.name,
      namespace: detail.namespace?.trim() || 'default',
      updatedAt: detail.updated_at,
      collaborationMode: detail.workflow?.mode?.trim() || 'solo',
      bots: detail.bots,
    }
  }

  return {
    listTeams,
    getExecutionProfile,
  }
}
