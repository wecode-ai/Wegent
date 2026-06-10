// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'
import { shouldClearDeviceSelectionForQuickLauncher } from '@/features/tasks/components/chat/quick-launch/execution-target'

function buildTeam(overrides: Partial<Team>): Team {
  return {
    id: 1,
    name: 'test-team',
    displayName: 'Test Team',
    description: '',
    bots: [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('shouldClearDeviceSelectionForQuickLauncher', () => {
  it('clears device selection for non-ClaudeCode teams', () => {
    const team = buildTeam({ agent_type: 'agno' })

    expect(shouldClearDeviceSelectionForQuickLauncher(team)).toBe(true)
  })

  it('keeps device selection for ClaudeCode teams using predefined bound models', () => {
    const team = buildTeam({
      agent_type: 'claude',
      bots: [
        {
          bot_id: 1,
          bot_prompt: '',
          bot: {
            shell_type: 'ClaudeCode',
            agent_config: {
              bind_model: 'claude-sonnet-4',
            },
          },
        },
      ],
    })

    expect(shouldClearDeviceSelectionForQuickLauncher(team)).toBe(false)
  })

  it('keeps device selection for ClaudeCode teams using Claude-compatible protocols', () => {
    const team = buildTeam({
      agent_type: 'ClaudeCode',
      bots: [
        {
          bot_id: 1,
          bot_prompt: '',
          bot: {
            shell_type: 'ClaudeCode',
            agent_config: {
              protocol: 'anthropic',
            },
          },
        },
      ],
    })

    expect(shouldClearDeviceSelectionForQuickLauncher(team)).toBe(false)
  })

  it('clears device selection for ClaudeCode teams using non-Claude protocols', () => {
    const team = buildTeam({
      agent_type: 'claude',
      bots: [
        {
          bot_id: 1,
          bot_prompt: '',
          bot: {
            shell_type: 'ClaudeCode',
            agent_config: {
              protocol: 'openai',
            },
          },
        },
      ],
    })

    expect(shouldClearDeviceSelectionForQuickLauncher(team)).toBe(true)
  })

  it('clears device selection when non-Claude protocol only appears in model env', () => {
    const team = buildTeam({
      agent_type: 'claude',
      bots: [
        {
          bot_id: 1,
          bot_prompt: '',
          bot: {
            shell_type: 'ClaudeCode',
            agent_config: {
              env: {
                model: 'openai',
              },
            },
          },
        },
      ],
    })

    expect(shouldClearDeviceSelectionForQuickLauncher(team)).toBe(true)
  })
})
