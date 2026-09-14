// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ModelCategoryType } from '@/apis/models'
import { filterSelectableShells, type UnifiedShell } from '@/apis/shells'
import type { Bot, TaskType } from '@/types/api'

export type SimpleExecutorMode = 'simple' | 'complex' | 'custom'
export type CodingExecutorRuntime = 'codex' | 'claude_code'
export type ExecutorNormalizationReason = 'requires_coding_agent' | null

export interface SimpleBindModeOption {
  value: Extract<TaskType, 'chat' | 'code' | 'task' | 'video' | 'image'>
  titleKey: string
  descriptionKey: string
}

export interface SimpleExecutorOption {
  value: SimpleExecutorMode
  titleKey: string
  descriptionKey: string
}

export interface NormalizedExecutor {
  mode: SimpleExecutorMode
  codingRuntime: CodingExecutorRuntime
  reason: ExecutorNormalizationReason
}

const SIMPLE_BIND_MODE_OPTIONS: SimpleBindModeOption[] = [
  {
    value: 'chat',
    titleKey: 'settings:team.simple.bind_mode.chat.title',
    descriptionKey: 'settings:team.simple.bind_mode.chat.description',
  },
  {
    value: 'code',
    titleKey: 'settings:team.simple.bind_mode.code.title',
    descriptionKey: 'settings:team.simple.bind_mode.code.description',
  },
  {
    value: 'task',
    titleKey: 'settings:team.simple.bind_mode.task.title',
    descriptionKey: 'settings:team.simple.bind_mode.task.description',
  },
  {
    value: 'video',
    titleKey: 'settings:team.simple.bind_mode.video.title',
    descriptionKey: 'settings:team.simple.bind_mode.video.description',
  },
  {
    value: 'image',
    titleKey: 'settings:team.simple.bind_mode.image.title',
    descriptionKey: 'settings:team.simple.bind_mode.image.description',
  },
]

const SIMPLE_EXECUTOR_OPTIONS: SimpleExecutorOption[] = [
  {
    value: 'simple',
    titleKey: 'settings:team.simple.executor.simple.title',
    descriptionKey: 'settings:team.simple.executor.simple.description',
  },
  {
    value: 'complex',
    titleKey: 'settings:team.simple.executor.complex.title',
    descriptionKey: 'settings:team.simple.executor.complex.description',
  },
  {
    value: 'custom',
    titleKey: 'settings:team.simple.executor.custom.title',
    descriptionKey: 'settings:team.simple.executor.custom.description',
  },
]

export function getDefaultSimpleBindMode(): TaskType[] {
  return ['chat']
}

export function getSimpleBindModeOptions(): SimpleBindModeOption[] {
  return SIMPLE_BIND_MODE_OPTIONS
}

export function getSimpleExecutorOptions(): SimpleExecutorOption[] {
  return SIMPLE_EXECUTOR_OPTIONS
}

export function bindModeRequiresCodingAgent(bindMode: TaskType[]): boolean {
  return bindMode.includes('code') || bindMode.includes('task')
}

export function getModelCategoryTypeForBindMode(bindMode: TaskType[]): ModelCategoryType {
  if (bindMode.length === 1 && bindMode[0] === 'image') return 'image'
  if (bindMode.length === 1 && bindMode[0] === 'video') return 'video'
  return 'llm'
}

export function isCodingAgentShell(shell: UnifiedShell | null | undefined): boolean {
  const shellType = shell?.shellType.toLowerCase()
  return shellType === 'codex' || shellType === 'claudecode'
}

type ShellIdentity = Pick<UnifiedShell, 'name'> & Partial<Pick<UnifiedShell, 'shellType'>>

export function shellSupportsPreloadSkills(shell: ShellIdentity | null | undefined): boolean {
  const shellType = (shell?.shellType || shell?.name || '').toLowerCase()
  return shellType === 'chat' || shellType === 'codex' || shellType === 'claudecode'
}

export function getCustomShells(shells: UnifiedShell[]): UnifiedShell[] {
  return filterSelectableShells(shells).filter(
    shell => shell.type === 'user' || shell.type === 'group'
  )
}

export function resolveShellForExecutor(
  shells: UnifiedShell[],
  mode: SimpleExecutorMode,
  customShellName?: string,
  codingRuntime: CodingExecutorRuntime = 'codex'
): UnifiedShell | null {
  if (mode === 'simple') {
    return shells.find(shell => shell.shellType === 'Chat') ?? null
  }

  if (mode === 'complex') {
    const shellType = codingRuntime === 'codex' ? 'codex' : 'claudecode'
    return shells.find(shell => shell.shellType.toLowerCase() === shellType) ?? null
  }

  if (!customShellName) {
    return null
  }

  return getCustomShells(shells).find(shell => shell.name === customShellName) ?? null
}

export function resolveSimpleExecutorFromBot(bot: Bot | undefined): {
  mode: SimpleExecutorMode
  codingRuntime: CodingExecutorRuntime
  customShellName: string
} {
  if (!bot) {
    return { mode: 'simple', codingRuntime: 'codex', customShellName: '' }
  }

  const shellType = bot.shell_type.toLowerCase()
  if (bot.shell_name === 'Codex') {
    return { mode: 'complex', codingRuntime: 'codex', customShellName: '' }
  }

  if (bot.shell_name === 'ClaudeCode') {
    return { mode: 'complex', codingRuntime: 'claude_code', customShellName: '' }
  }

  if (bot.shell_name === 'Chat') {
    return { mode: 'simple', codingRuntime: 'codex', customShellName: '' }
  }

  if (!bot.shell_name && shellType === 'codex') {
    return { mode: 'complex', codingRuntime: 'codex', customShellName: '' }
  }

  if (!bot.shell_name && shellType === 'claudecode') {
    return { mode: 'complex', codingRuntime: 'claude_code', customShellName: '' }
  }

  return { mode: 'custom', codingRuntime: 'codex', customShellName: bot.shell_name }
}

export function normalizeExecutorForBindMode(
  mode: SimpleExecutorMode,
  bindMode: TaskType[],
  shells: UnifiedShell[],
  customShellName?: string,
  codingRuntime: CodingExecutorRuntime = 'codex'
): NormalizedExecutor {
  if (!bindModeRequiresCodingAgent(bindMode)) {
    return { mode, codingRuntime, reason: null }
  }

  if (mode === 'custom') {
    return { mode, codingRuntime, reason: null }
  }

  const selectedShell = resolveShellForExecutor(shells, mode, customShellName, codingRuntime)
  if (isCodingAgentShell(selectedShell)) {
    return { mode, codingRuntime, reason: null }
  }

  if (resolveShellForExecutor(shells, 'complex', undefined, 'codex')) {
    return { mode: 'complex', codingRuntime: 'codex', reason: 'requires_coding_agent' }
  }

  if (resolveShellForExecutor(shells, 'complex', undefined, 'claude_code')) {
    return {
      mode: 'complex',
      codingRuntime: 'claude_code',
      reason: 'requires_coding_agent',
    }
  }

  return { mode, codingRuntime, reason: 'requires_coding_agent' }
}
