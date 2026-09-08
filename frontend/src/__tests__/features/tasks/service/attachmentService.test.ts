// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { isCodeRuntimeShell, supportsAttachments } from '@/features/tasks/service/attachmentService'
import type { Team } from '@/types/api'

function teamWithShell(shellType: string): Team {
  return {
    id: 1,
    name: `${shellType}-team`,
    description: '',
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
    agent_type: shellType,
    bots: [],
  }
}

describe('attachmentService', () => {
  it.each(['ClaudeCode', 'Codex'])('supports attachments for the %s code runtime', shellType => {
    const team = teamWithShell(shellType)

    expect(isCodeRuntimeShell(team)).toBe(true)
    expect(supportsAttachments(team)).toBe(true)
  })

  it('detects Codex from task-detail bot data', () => {
    const team = {
      ...teamWithShell(''),
      agent_type: undefined,
      bots: [{ bot_id: 1, bot_prompt: '', bot: { shell_type: 'Codex' } }],
    }

    expect(isCodeRuntimeShell(team)).toBe(true)
    expect(supportsAttachments(team)).toBe(true)
  })
})
