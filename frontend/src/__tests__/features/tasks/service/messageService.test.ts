// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  canSwitchModelAfterMessages,
  canUseChatContexts,
} from '@/features/tasks/service/messageService'
import type { Team } from '@/types/api'

function createTeam(agentType: string, shellType?: string): Team {
  return {
    id: 1,
    name: `${agentType} Team`,
    description: '',
    bots: shellType
      ? [
          {
            bot_id: 1,
            bot_prompt: '',
            bot: { shell_type: shellType },
          },
        ]
      : [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '',
    updated_at: '',
    agent_type: agentType,
  }
}

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

describe('messageService canSwitchModelAfterMessages', () => {
  it('allows chat shell teams to switch models after messages exist', () => {
    expect(canSwitchModelAfterMessages(createTeam('chat'))).toBe(true)
  })

  it('allows ClaudeCode teams to switch models after messages exist', () => {
    expect(canSwitchModelAfterMessages(createTeam('ClaudeCode'))).toBe(true)
  })

  it('allows ClaudeCode teams detected from bot shell type', () => {
    expect(canSwitchModelAfterMessages(createTeam('', 'ClaudeCode'))).toBe(true)
  })

  it('keeps unknown shells disabled after messages exist', () => {
    expect(canSwitchModelAfterMessages(createTeam('Dify'))).toBe(false)
  })
})
