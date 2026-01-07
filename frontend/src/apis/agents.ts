// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import { PaginationParams } from '../types/api'

// Agent Types
export interface Agent {
  name: string
  config: Record<string, unknown>
  id: number
  created_at: string
  updated_at: string
}

export interface AgentListResponse {
  total: number
  items: Agent[]
}

// Agent Services
export const agentApis = {
  async getAgents(params?: PaginationParams): Promise<AgentListResponse> {
    const query = params ? `?page=${params.page || 1}` : ''
    return apiClient.get(`/agents${query}`)
  },

  async getAgent(id: number): Promise<Agent> {
    return apiClient.get(`/agents/${id}`)
  },
}
