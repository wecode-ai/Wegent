import type {
  InstalledSkill,
  InstalledSkillListResponse,
  PersonalSkill,
  PersonalSkillListResponse,
  SystemSkillInstallRequest,
  SystemSkillListResponse,
  SystemSkillProviderListResponse,
} from '@/types/api'
import { getRuntimeConfig } from '@/config/runtime'
import type { HttpClient } from './http'

export interface SystemSkillListParams {
  providerKey?: string
  keyword?: string
  tags?: string[]
  page?: number
  pageSize?: number
  category?: 'system'
}

export function createSystemSkillApi(client: HttpClient) {
  return {
    listProviders(): Promise<SystemSkillProviderListResponse> {
      return client.get('/system-skills/providers')
    },
    installSystemSkill(
      data: SystemSkillInstallRequest,
    ): Promise<InstalledSkill> {
      return client.post('/system-skills/install', data)
    },
    installPersonalSkill(skillId: number): Promise<InstalledSkill> {
      return client.post('/system-skills/install/personal', { skillId })
    },
    listInstalledSystemSkills(): Promise<InstalledSkillListResponse> {
      return client.get('/system-skills/installed')
    },
    updateInstalledSystemSkill(
      id: number,
      enabled: boolean,
    ): Promise<InstalledSkill> {
      return client.put(`/system-skills/installed/${id}`, { enabled })
    },
    uninstallInstalledSystemSkill(id: number): Promise<void> {
      return client.delete(`/system-skills/installed/${id}`)
    },
    listSystemSkills(
      params: SystemSkillListParams = {},
    ): Promise<SystemSkillListResponse> {
      const query = new URLSearchParams()
      query.set('category', params.category ?? 'system')
      query.set('page', String(params.page ?? 1))
      query.set('pageSize', String(params.pageSize ?? 20))

      if (params.providerKey) {
        query.set('providerKey', params.providerKey)
      }
      if (params.keyword?.trim()) {
        query.set('keyword', params.keyword.trim())
      }
      if (params.tags?.length) {
        query.set('tags', params.tags.join(','))
      }

      return client.get(`/system-skills?${query.toString()}`)
    },
    listPersonalSkills(): Promise<PersonalSkillListResponse> {
      return client.get('/v1/kinds/skills?namespace=default&limit=100')
    },
    uploadPersonalSkill(file: File, name: string): Promise<PersonalSkill> {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('name', name)
      formData.append('namespace', 'default')

      const { apiBaseUrl } = getRuntimeConfig()

      return fetch(`${apiBaseUrl}/v1/kinds/skills/upload`, {
        method: 'POST',
        headers: {
          ...(localStorage.getItem('auth_token')
            ? { Authorization: `Bearer ${localStorage.getItem('auth_token')}` }
            : {}),
        },
        body: formData,
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error((await response.text()) || `HTTP ${response.status}`)
        }
        return response.json() as Promise<PersonalSkill>
      })
    },
    deletePersonalSkill(id: number): Promise<void> {
      return client.delete(`/v1/kinds/skills/${id}`)
    },
    updatePersonalSkillEnabled(
      id: number,
      enabled: boolean,
    ): Promise<PersonalSkill> {
      return client.put(`/v1/kinds/skills/${id}/enabled`, { enabled })
    },
  }
}
