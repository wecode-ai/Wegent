// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { canUseChatContexts } from '@/features/tasks/service/messageService'
import type { Team } from '@/types/api'

describe('messageService canUseChatContexts', () => {
  it('returns true for device task mode without requiring a chat shell team', () => {
    expect(canUseChatContexts('task', null)).toBe(true)
  })

  it('returns false for code mode', () => {
    expect(canUseChatContexts('code', null)).toBe(false)
  })

  it('returns true for chat shell teams in chat mode', () => {
    const team = {
      id: 1,
      name: 'Chat Team',
      description: '',
      bots: [],
      workflow: {},
      is_active: true,
      user_id: 1,
      created_at: '',
      updated_at: '',
      agent_type: 'chat',
    } satisfies Team

    expect(canUseChatContexts('chat', team)).toBe(true)
  })
})
