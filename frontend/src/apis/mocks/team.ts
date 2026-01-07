// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TeamListResponse } from '@/apis/team'
import { Team } from '@/types/api'
import { http, HttpResponse } from 'msw'

export const MOCK_TEAMS: Team[] = [
  {
    id: 1,
    name: 'Frontend Team',
    description: 'Responsible for the user interface.',
    bots: [
      { bot_id: 1, bot_prompt: 'Analyze UI requirements' },
      { bot_id: 2, bot_prompt: 'Implement UI components' },
    ],
    workflow: { type: 'agile' },
    is_active: true,
    user_id: 1,
    created_at: '2024-07-01T00:00:00Z',
    updated_at: '2024-07-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Backend Team',
    description: 'Manages the server-side logic and database.',
    bots: [
      { bot_id: 3, bot_prompt: 'Design API endpoints' },
      { bot_id: 4, bot_prompt: 'Implement business logic' },
    ],
    workflow: { type: 'kanban' },
    is_active: true,
    user_id: 1,
    created_at: '2024-07-01T00:00:00Z',
    updated_at: '2024-07-01T00:00:00Z',
  },
]

export const teamHandlers = [
  http.get('/api/teams', () => {
    const response: TeamListResponse = {
      total: MOCK_TEAMS.length,
      items: MOCK_TEAMS,
    }
    return HttpResponse.json(response)
  }),

  http.post<never, Record<string, unknown>>('/api/teams', async ({ request }) => {
    const teamData = (await request.json()) as Partial<Team>
    const newTeam: Team = {
      id: MOCK_TEAMS.length + 1,
      name: teamData.name || 'New Team',
      description: teamData.description || '',
      bots: teamData.bots || [],
      workflow: teamData.workflow || {},
      is_active: true,
      user_id: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    MOCK_TEAMS.push(newTeam)
    return HttpResponse.json(newTeam, { status: 201 })
  }),

  http.put<{ id: string }, Record<string, unknown>>(
    '/api/teams/:id',
    async ({ params, request }) => {
      const { id } = params
      const teamData = await request.json()
      const index = MOCK_TEAMS.findIndex(t => t.id === Number(id))
      if (index !== -1) {
        MOCK_TEAMS[index] = {
          ...MOCK_TEAMS[index],
          ...teamData,
          updated_at: new Date().toISOString(),
        }
        return HttpResponse.json(MOCK_TEAMS[index])
      } else {
        return new HttpResponse(null, { status: 404 })
      }
    }
  ),

  http.delete('/api/teams/:id', ({ params }) => {
    const { id } = params
    const index = MOCK_TEAMS.findIndex(t => t.id === Number(id))
    if (index !== -1) {
      MOCK_TEAMS.splice(index, 1)
      return HttpResponse.json({ message: 'Team deleted successfully' })
    } else {
      return new HttpResponse(null, { status: 404 })
    }
  }),
]
