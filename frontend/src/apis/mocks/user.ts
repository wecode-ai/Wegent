// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { User } from '@/types/api'

export const MOCK_USER: User = {
  id: 1,
  user_name: 'admin',
  email: 'admin@example.com',
  is_active: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  git_info: [
    {
      git_domain: 'github.com',
      git_token: 'mock_token',
      type: 'github'
    }
  ]
}
import { http, HttpResponse } from 'msw'

export const authHandlers = [
  http.post('/api/auth/login', async ({ request }) => {
    const body = await request.json()
    if (typeof body !== 'object' || body === null || !('user_name' in body) || !('password' in body)) {
      return HttpResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const { user_name, password } = body as { user_name: string, password: string }

    if (user_name === 'admin' && password === 'admin') {
      return HttpResponse.json({
        access_token: 'mock-token',
        token_type: 'bearer'
      })
    } else {
      return HttpResponse.json({ detail: 'Incorrect username or password' }, { status: 401 })
    }
  }),
  http.get('/api/users/me', () => {
    return HttpResponse.json(MOCK_USER)
  }),
  http.put<never, any>('/api/users/me', async ({ request }) => {
    const userData = await request.json()
    const updatedUser = { ...MOCK_USER, ...userData, updated_at: new Date().toISOString() }
    return HttpResponse.json(updatedUser)
  })
]