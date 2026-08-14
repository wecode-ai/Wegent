// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import apiClient from '@/apis/client'

export interface UsageAgent {
  name: string
  namespace: string
  owner_user_id: number
  author_name: string
  is_owner: boolean
}

export interface UsageAgentPage {
  items: UsageAgent[]
  has_more: boolean
  next_offset: number
}

export interface UsageRow {
  agent_name: string
  agent_namespace: string
  author_name: string
  pv: number
  uv: number
  ai_rounds?: number
  completed_ai_rounds?: number
}

export interface UsageResult {
  rows: UsageRow[]
  daily_rows: UsageDailyRow[]
  pv: number
  uv: number
  ai_rounds?: number
  completed_ai_rounds?: number
}

export interface UsageDailyRow {
  date: string
  agent_name: string
  agent_namespace: string
  pv: number
  uv: number
  ai_rounds?: number
  completed_ai_rounds?: number
}

export const agentUsageApi = {
  listAgents: (query = '', offset = 0) =>
    apiClient.get<UsageAgentPage>(
      `/wecode/agent-usage/agents?q=${encodeURIComponent(query)}&limit=50&offset=${offset}`
    ),
  query: (startDate: string, endDate: string, agents: UsageAgent[]) =>
    apiClient.post<UsageResult>('/wecode/agent-usage/query', {
      start_date: startDate,
      end_date: endDate,
      agents,
    }),
}
