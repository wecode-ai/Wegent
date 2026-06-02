import type { Team } from '@/types/api'
import type { HttpClient } from './http'

interface TeamListResponse {
  total: number
  items: Team[]
}

function isActive(team: Team): boolean {
  return team.is_active !== false
}

export function createTeamApi(client: HttpClient) {
  async function listTeams(): Promise<Team[]> {
    const response = await client.get<TeamListResponse>('/teams?page=1&limit=100')
    return response.items
  }

  return {
    listTeams,
    async getDefaultWorkbenchTeam(): Promise<Team> {
      const teams = (await listTeams()).filter(isActive)
      const weworkTeam = teams.find(team => team.default_for_modes?.includes('wework'))
      const codeTeam = teams.find(team => team.default_for_modes?.includes('code'))
      const chatTeam = teams.find(team => team.default_for_modes?.includes('chat'))
      const fallback = teams[0]

      if (!weworkTeam && !codeTeam && !chatTeam && !fallback) {
        throw new Error('No active team is available')
      }

      return weworkTeam ?? codeTeam ?? chatTeam ?? fallback
    },
  }
}
