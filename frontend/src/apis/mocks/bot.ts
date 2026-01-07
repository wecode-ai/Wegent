// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { BotListResponse, CreateBotRequest, UpdateBotRequest } from '@/apis/bots'
import { Bot } from '@/types/api'
import { http, HttpResponse } from 'msw'

export const MOCK_BOTS: Bot[] = [
  {
    id: 1,
    name: 'Code Reviewer',
    shell_name: 'ClaudeCode',
    shell_type: 'ClaudeCode',
    agent_config: { model: 'claude-3-opus-20240229' },
    system_prompt: 'You are a senior software engineer. Please review the code for any issues.',
    mcp_servers: {},
    is_active: true,
    created_at: '2024-07-01T00:00:00Z',
    updated_at: '2024-07-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Unit Test Writer',
    shell_name: 'ClaudeCode',
    shell_type: 'ClaudeCode',
    agent_config: { model: 'claude-3-sonnet-20240229' },
    system_prompt: 'You are a QA engineer. Please write unit tests for the given code.',
    mcp_servers: {},
    is_active: true,
    created_at: '2024-07-02T00:00:00Z',
    updated_at: '2024-07-02T00:00:00Z',
  },
]

export const botHandlers = [
  http.get('/api/bots', () => {
    const response: BotListResponse = {
      total: MOCK_BOTS.length,
      items: MOCK_BOTS,
    }
    return HttpResponse.json(response)
  }),

  http.post<never, CreateBotRequest>('/api/bots', async ({ request }) => {
    const botData = await request.json()
    const newBot: Bot = {
      id: MOCK_BOTS.length + 1,
      ...botData,
      shell_type: botData.shell_name, // For mock, shell_type equals shell_name
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    MOCK_BOTS.push(newBot)
    return HttpResponse.json(newBot, { status: 201 })
  }),

  http.put<{ id: string }, UpdateBotRequest>('/api/bots/:id', async ({ params, request }) => {
    const { id } = params
    const botData = await request.json()
    const index = MOCK_BOTS.findIndex(b => b.id === Number(id))
    if (index !== -1) {
      MOCK_BOTS[index] = { ...MOCK_BOTS[index], ...botData, updated_at: new Date().toISOString() }
      return HttpResponse.json(MOCK_BOTS[index])
    } else {
      return new HttpResponse(null, { status: 404 })
    }
  }),

  http.delete('/api/bots/:id', ({ params }) => {
    const { id } = params
    const index = MOCK_BOTS.findIndex(b => b.id === Number(id))
    if (index !== -1) {
      MOCK_BOTS.splice(index, 1)
      return HttpResponse.json({ message: 'Bot deleted successfully' })
    } else {
      return new HttpResponse(null, { status: 404 })
    }
  }),
]
