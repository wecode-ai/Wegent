import type { Team } from '@/types/api'
import type { HttpClient, HttpRequestOptions } from './http'

interface TeamListResponse {
  total: number
  items: Team[]
}

function isActive(team: Team): boolean {
  return team.is_active !== false
}

export function createTeamApi(client: HttpClient) {
  async function listTeams(requestOptions?: Pick<HttpRequestOptions, 'signal'>): Promise<Team[]> {
    const response = requestOptions
      ? await client.get<TeamListResponse>('/teams?page=1&limit=100', requestOptions)
      : await client.get<TeamListResponse>('/teams?page=1&limit=100')
    return response.items
  }

  return {
    listTeams,
    async getDefaultWorkbenchTeam(): Promise<Team> {
      const teams = (await listTeams()).filter(isActive)
      const weworkTeam = teams.find(team => team.default_for_modes?.includes('wework'))

      if (!weworkTeam) {
        throw new Error('Wework default team is not configured')
      }

      return weworkTeam
    },
  }
}
