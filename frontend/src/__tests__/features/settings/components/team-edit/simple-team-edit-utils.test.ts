// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedShell } from '@/apis/shells'
import type { TaskType } from '@/types/api'
import {
  getDefaultSimpleBindMode,
  getCustomShells,
  getSimpleBindModeOptions,
  getSimpleExecutorOptions,
  normalizeExecutorForBindMode,
  resolveSimpleExecutorFromBot,
  resolveShellForExecutor,
  type SimpleExecutorMode,
} from '@/features/settings/components/team-edit/simple-team-edit-utils'
import type { Bot } from '@/types/api'

const shells: UnifiedShell[] = [
  {
    name: 'Chat',
    type: 'public',
    displayName: 'Chat',
    shellType: 'Chat',
  },
  {
    name: 'ClaudeCode',
    type: 'public',
    displayName: 'Claude Code',
    shellType: 'ClaudeCode',
  },
  {
    name: 'custom-chat',
    type: 'user',
    displayName: 'Custom Chat',
    shellType: 'Chat',
  },
  {
    name: 'custom-code',
    type: 'group',
    displayName: 'Custom Code',
    shellType: 'ClaudeCode',
    namespace: 'dev-group',
  },
  {
    name: 'custom-agno',
    type: 'group',
    displayName: 'Custom Agno',
    shellType: 'Agno',
    namespace: 'dev-group',
  },
]

const bot: Bot = {
  id: 10,
  name: 'bot',
  namespace: 'default',
  shell_name: 'Chat',
  shell_type: 'Chat',
  agent_config: {},
  system_prompt: '',
  mcp_servers: {},
  is_active: true,
  created_at: '2026-05-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
}

describe('simple team edit utils', () => {
  it('defaults simple bind mode to chat only', () => {
    expect(getDefaultSimpleBindMode()).toEqual(['chat'])
  })

  it('only exposes chat, code, and task bind modes', () => {
    expect(getSimpleBindModeOptions().map(option => option.value)).toEqual(['chat', 'code', 'task'])
  })

  it('exposes simple, complex, and custom executor presets', () => {
    expect(getSimpleExecutorOptions().map(option => option.value)).toEqual([
      'simple',
      'complex',
      'custom',
    ])
  })

  it('resolves simple executor to Chat shell', () => {
    expect(resolveShellForExecutor(shells, 'simple')?.name).toBe('Chat')
  })

  it('resolves complex executor to ClaudeCode shell', () => {
    expect(resolveShellForExecutor(shells, 'complex')?.name).toBe('ClaudeCode')
  })

  it('resolves custom executor by selected custom shell name', () => {
    expect(resolveShellForExecutor(shells, 'custom', 'custom-code')?.name).toBe('custom-code')
  })

  it('resolves built-in executor mode from shell name', () => {
    expect(resolveSimpleExecutorFromBot({ ...bot, shell_name: 'Chat', shell_type: 'Chat' })).toEqual(
      {
        mode: 'simple',
        customShellName: '',
      }
    )
    expect(
      resolveSimpleExecutorFromBot({
        ...bot,
        shell_name: 'ClaudeCode',
        shell_type: 'ClaudeCode',
      })
    ).toEqual({
      mode: 'complex',
      customShellName: '',
    })
  })

  it('keeps custom ClaudeCode shell selected as a custom executor', () => {
    expect(
      resolveSimpleExecutorFromBot({
        ...bot,
        shell_name: 'custom-code',
        shell_type: 'ClaudeCode',
      })
    ).toEqual({
      mode: 'custom',
      customShellName: 'custom-code',
    })
  })

  it('excludes Agno custom shells from custom executor choices', () => {
    expect(getCustomShells(shells).map(shell => shell.name)).toEqual(['custom-chat', 'custom-code'])
  })

  it('does not resolve custom executor without a selected shell', () => {
    expect(resolveShellForExecutor(shells, 'custom')).toBeNull()
  })

  it('normalizes simple executor to complex for code and device bind modes', () => {
    const bindMode = ['chat', 'code'] as TaskType[]

    expect(normalizeExecutorForBindMode('simple', bindMode, shells)).toEqual({
      mode: 'complex',
      reason: 'requires_claude_code',
    })
  })

  it('keeps custom executor when its selected shell is ClaudeCode-compatible', () => {
    const bindMode = ['task'] as TaskType[]

    expect(normalizeExecutorForBindMode('custom', bindMode, shells, 'custom-code')).toEqual({
      mode: 'custom',
      reason: null,
    })
  })

  it('keeps custom executor selectable even when the selected shell needs validation', () => {
    const bindMode = ['code'] as TaskType[]

    expect(normalizeExecutorForBindMode('custom', bindMode, shells, 'custom-chat')).toEqual({
      mode: 'custom',
      reason: null,
    })
  })

  it('keeps custom executor selectable before a custom shell is chosen', () => {
    const bindMode = ['code'] as TaskType[]

    expect(normalizeExecutorForBindMode('custom', bindMode, shells, '')).toEqual({
      mode: 'custom',
      reason: null,
    })
  })

  it('falls back to simple when chat is the only selected bind mode', () => {
    const bindMode = ['chat'] as TaskType[]
    const mode: SimpleExecutorMode = 'simple'

    expect(normalizeExecutorForBindMode(mode, bindMode, shells)).toEqual({
      mode: 'simple',
      reason: null,
    })
  })
})
