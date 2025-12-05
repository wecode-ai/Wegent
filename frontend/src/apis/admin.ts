// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'

// Quick team types
export interface QuickTeamItem {
  team_id: number
  icon: string
  sort_order: number
}

export interface QuickTeamsConfig {
  chat: QuickTeamItem[]
  code: QuickTeamItem[]
}

export interface QuickTeamResponse {
  team_id: number
  team_name: string
  team_namespace: string
  description: string | null
  icon: string
  sort_order: number
}

export interface QuickTeamsListResponse {
  items: QuickTeamResponse[]
}

export interface AvailableTeam {
  team_id: number
  team_name: string
  team_namespace: string
  description: string | null
  user_id: number
}

export interface AvailableTeamsResponse {
  items: AvailableTeam[]
}

export const adminApis = {
  // Get quick teams for a scene (public)
  async getQuickTeams(scene: 'chat' | 'code'): Promise<QuickTeamsListResponse> {
    return apiClient.get(`/quick-teams?scene=${scene}`)
  },

  // Get quick teams config (admin only)
  async getQuickTeamsConfig(): Promise<QuickTeamsConfig> {
    return apiClient.get('/admin/quick-teams/config')
  },

  // Update quick teams config (admin only)
  async updateQuickTeamsConfig(config: QuickTeamsConfig): Promise<{ message: string }> {
    return apiClient.put('/admin/quick-teams/config', config)
  },

  // Get all available teams for config (admin only)
  async getAvailableTeamsForConfig(): Promise<AvailableTeamsResponse> {
    return apiClient.get('/admin/quick-teams/available-teams')
  },
}
