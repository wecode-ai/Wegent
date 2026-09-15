import { fetchAllTeams } from '@wegent/chat-core'
import type { Team } from '@/types/api'
import type { HttpClient, HttpRequestOptions } from './http'

interface TeamListResponse {
  total: number
  items: Team[]
}

export function createTeamApi(client: HttpClient) {
  async function listTeams(requestOptions?: Pick<HttpRequestOptions, 'signal'>): Promise<Team[]> {
    const response = await fetchAllTeams((page, limit) => {
      const endpoint = `/teams?page=${page}&limit=${limit}`
      return requestOptions
        ? client.get<TeamListResponse>(endpoint, requestOptions)
        : client.get<TeamListResponse>(endpoint)
    })
    return response.items
  }

  return {
    listTeams,
  }
}
