import type { Team } from '@/types/api'
import type { HttpClient, HttpRequestOptions } from './http'

interface TeamListResponse {
  total: number
  items: Team[]
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
  }
}
