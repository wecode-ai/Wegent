// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isCodingAgentShell, supportsAttachments } from '@/features/tasks/service/attachmentService'
import type { Team } from '@/types/api'

function createTeam(agentType: string, shellType?: string): Team {
  return {
    id: 1,
    name: 'test-team',
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

describe('attachmentService coding agents', () => {
  it.each(['Codex', 'ClaudeCode'])(
    'supports attachments when %s is the team agent type',
    agentType => {
      const team = createTeam(agentType)

      expect(isCodingAgentShell(team)).toBe(true)
      expect(supportsAttachments(team)).toBe(true)
    }
  )

  it.each(['Codex', 'ClaudeCode'])(
    'supports attachments when %s is detected from the bot shell',
    shellType => {
      const team = createTeam('', shellType)

      expect(isCodingAgentShell(team)).toBe(true)
      expect(supportsAttachments(team)).toBe(true)
    }
  )
})
