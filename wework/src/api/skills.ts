import type { HttpClient } from './http'
import type { UnifiedSkill } from '@/types/api'

export interface TeamSkillsResponse {
  skills: string[]
  preload_skills: string[]
}

export function createSkillApi(client: HttpClient) {
  return {
    listSkills(): Promise<UnifiedSkill[]> {
      const query = new URLSearchParams()
      query.set('scope', 'all')
      return client.get(`/v1/kinds/skills/unified?${query.toString()}`)
    },
    getTeamSkills(teamId: number): Promise<TeamSkillsResponse> {
      return client.get(`/teams/${teamId}/skills`)
    },
  }
}
