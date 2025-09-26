// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import type { TeamBot, Team, PaginationParams } from '@/types/api'

// Team Request/Response Types
export interface CreateTeamRequest {
  name: string
  description?: string
  bots?: TeamBot[]
  workflow?: Record<string, any>
  is_active?: boolean
}

export interface TeamListResponse {
  total: number
  items: Team[]
}



export const teamApis = {
  async getTeams(params?: PaginationParams): Promise<TeamListResponse> {
    const p = params ? params : { page: 1, limit: 100 }
    const query = p ? `?page=${p.page || 1}&limit=${p.limit || 100}` : ''
    return apiClient.get(`/teams${query}`)
  },
  async createTeam(data: CreateTeamRequest): Promise<Team> {
    return apiClient.post('/teams', data)
  },
  async deleteTeam(id: number): Promise<void> {
    await apiClient.delete(`/teams/${id}`)
  },
  async updateTeam(id: number, data: CreateTeamRequest): Promise<Team> {
    return apiClient.put(`/teams/${id}`, data)
  },
}
