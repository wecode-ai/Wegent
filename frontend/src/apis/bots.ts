// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { apiClient } from './client'
import { Bot, PaginationParams, SuccessMessage } from '../types/api'
import type { CheckRunningTasksResponse } from './common'

// Bot Request/Response Types
export interface CreateBotRequest {
  name: string
  shell_name: string // Shell name (e.g., 'ClaudeCode', 'Agno', 'my-custom-shell')
  agent_config: Record<string, unknown>
  system_prompt: string
  mcp_servers: Record<string, unknown>
  skills?: string[]
  preload_skills?: string[] // Skills to preload into system prompt
  namespace?: string // Group namespace, defaults to 'default' for personal bots
}

export interface UpdateBotRequest {
  name?: string
  shell_name?: string // Shell name (e.g., 'ClaudeCode', 'Agno', 'my-custom-shell')
  agent_config?: Record<string, unknown>
  system_prompt?: string
  mcp_servers?: Record<string, unknown>
  skills?: string[]
  preload_skills?: string[] // Skills to preload into system prompt
  is_active?: boolean
  namespace?: string // Group namespace
}
export interface BotListResponse {
  total: number
  items: Bot[]
}

// Bot Services
export const botApis = {
  async getBots(
    params?: PaginationParams,
    scope?: 'personal' | 'group' | 'all',
    groupName?: string
  ): Promise<BotListResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('page', String(params?.page || 1))
    queryParams.append('limit', String(params?.limit || 100))
    if (scope) {
      queryParams.append('scope', scope)
    }
    if (groupName) {
      queryParams.append('group_name', groupName)
    }
    return apiClient.get(`/bots?${queryParams.toString()}`)
  },
  async getBot(id: number): Promise<Bot> {
    return apiClient.get(`/bots/${id}`)
  },

  async createBot(data: CreateBotRequest): Promise<Bot> {
    return apiClient.post('/bots', data)
  },

  async updateBot(id: number, data: UpdateBotRequest): Promise<Bot> {
    return apiClient.put(`/bots/${id}`, data)
  },

  async deleteBot(id: number, force: boolean = false): Promise<SuccessMessage> {
    const queryParams = force ? '?force=true' : ''
    return apiClient.delete(`/bots/${id}${queryParams}`)
  },

  async checkRunningTasks(id: number): Promise<CheckRunningTasksResponse> {
    return apiClient.get(`/bots/${id}/running-tasks`)
  },
}
