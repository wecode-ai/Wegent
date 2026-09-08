// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedShell } from '@/apis/shells'
import type { Bot } from '@/types/api'
import {
  getAllowedAgentsForTeamMode,
  getFilteredBotsForMode,
  getSelectableTeamModes,
} from '@/features/settings/components/team-modes'

const bots = [
  { id: 1, name: 'chat', shell_type: 'Chat' },
  { id: 2, name: 'claude', shell_type: 'ClaudeCode' },
  { id: 3, name: 'codex', shell_type: 'Codex' },
  { id: 4, name: 'agno', shell_type: 'Agno' },
  { id: 5, name: 'custom-code', shell_type: 'custom-code' },
  { id: 6, name: 'custom-agno', shell_type: 'custom-agno' },
] as Bot[]

const shells: UnifiedShell[] = [
  {
    name: 'custom-code',
    type: 'user',
    displayName: 'Custom Code',
    shellType: 'ClaudeCode',
  },
  {
    name: 'custom-agno',
    type: 'user',
    displayName: 'Custom Agno',
    shellType: 'Agno',
  },
]

describe('team modes', () => {
  it('only exposes collaboration modes that remain selectable without Agno', () => {
    expect(getSelectableTeamModes()).toEqual(['solo', 'pipeline', 'coordinate'])
  })

  it('limits non-solo selectable collaboration modes to code runtimes', () => {
    expect(getAllowedAgentsForTeamMode('pipeline')).toEqual(['ClaudeCode', 'Codex'])
    expect(getAllowedAgentsForTeamMode('coordinate')).toEqual(['ClaudeCode', 'Codex'])
  })

  it('excludes Agno bots and custom Agno shells from mode-compatible bots', () => {
    expect(getFilteredBotsForMode(bots, 'solo', shells).map(bot => bot.name)).toEqual([
      'chat',
      'claude',
      'codex',
      'custom-code',
    ])
    expect(getFilteredBotsForMode(bots, 'pipeline', shells).map(bot => bot.name)).toEqual([
      'claude',
      'codex',
      'custom-code',
    ])
  })
})
