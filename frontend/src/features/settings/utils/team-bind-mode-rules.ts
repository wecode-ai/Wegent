// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType } from '@/types/api'

export type TeamExecutorAgent = 'ClaudeCode' | 'Codex' | 'Agno' | 'Dify'

const CODE_RUNTIME_AGENTS: TeamExecutorAgent[] = ['ClaudeCode', 'Codex']

export function requiresCodeRuntimeForBindMode(bindMode: TaskType[]): boolean {
  return bindMode.includes('code') || bindMode.includes('task')
}

export function getAllowedAgentsForBindMode(
  bindMode: TaskType[],
  allowedAgents?: TeamExecutorAgent[]
): TeamExecutorAgent[] | undefined {
  if (!requiresCodeRuntimeForBindMode(bindMode)) {
    return allowedAgents
  }

  return allowedAgents
    ? CODE_RUNTIME_AGENTS.filter(agent => allowedAgents.includes(agent))
    : CODE_RUNTIME_AGENTS
}
