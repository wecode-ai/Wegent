// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType } from '@/types/api'

export type TeamExecutorAgent = 'ClaudeCode' | 'Agno' | 'Dify'

const CLAUDE_CODE_AGENT: TeamExecutorAgent = 'ClaudeCode'

export function requiresClaudeCodeForBindMode(bindMode: TaskType[]): boolean {
  return bindMode.includes('code') || bindMode.includes('task')
}

export function getAllowedAgentsForBindMode(
  bindMode: TaskType[],
  allowedAgents?: TeamExecutorAgent[]
): TeamExecutorAgent[] | undefined {
  if (!requiresClaudeCodeForBindMode(bindMode)) {
    return allowedAgents
  }

  return [CLAUDE_CODE_AGENT]
}
