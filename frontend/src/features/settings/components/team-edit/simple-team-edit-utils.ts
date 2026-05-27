// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedShell } from '@/apis/shells'
import type { TaskType } from '@/types/api'

export type SimpleExecutorMode = 'simple' | 'complex' | 'custom'
export type ExecutorNormalizationReason = 'requires_claude_code' | null

export interface SimpleBindModeOption {
  value: Extract<TaskType, 'chat' | 'code' | 'task'>
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

export function bindModeRequiresClaudeCode(bindMode: TaskType[]): boolean {
  return bindMode.includes('code') || bindMode.includes('task')
}

export function isClaudeCodeShell(shell: UnifiedShell | null | undefined): boolean {
  return shell?.shellType === 'ClaudeCode'
}

export function getCustomShells(shells: UnifiedShell[]): UnifiedShell[] {
  return shells.filter(shell => shell.type === 'user' || shell.type === 'group')
}

export function resolveShellForExecutor(
  shells: UnifiedShell[],
  mode: SimpleExecutorMode,
  customShellName?: string
): UnifiedShell | null {
  if (mode === 'simple') {
    return shells.find(shell => shell.shellType === 'Chat') ?? null
  }

  if (mode === 'complex') {
    return shells.find(shell => shell.shellType === 'ClaudeCode') ?? null
  }

  if (!customShellName) {
    return null
  }

  return getCustomShells(shells).find(shell => shell.name === customShellName) ?? null
}

export function normalizeExecutorForBindMode(
  mode: SimpleExecutorMode,
  bindMode: TaskType[],
  shells: UnifiedShell[],
  customShellName?: string
): NormalizedExecutor {
  if (!bindModeRequiresClaudeCode(bindMode)) {
    return { mode, reason: null }
  }

  if (mode === 'custom') {
    return { mode, reason: null }
  }

  const selectedShell = resolveShellForExecutor(shells, mode, customShellName)
  if (isClaudeCodeShell(selectedShell)) {
    return { mode, reason: null }
  }

  const complexShell = resolveShellForExecutor(shells, 'complex')
  if (complexShell) {
    return { mode: 'complex', reason: 'requires_claude_code' }
  }

  return { mode, reason: 'requires_claude_code' }
}
