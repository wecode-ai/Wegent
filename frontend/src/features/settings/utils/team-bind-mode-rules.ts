// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType } from '@/types/api'

export type TeamExecutorAgent = 'Codex' | 'ClaudeCode' | 'Agno' | 'Dify'

const CODING_AGENTS: TeamExecutorAgent[] = ['Codex', 'ClaudeCode']

export function requiresCodingAgentForBindMode(bindMode: TaskType[]): boolean {
  return bindMode.includes('code') || bindMode.includes('task')
}

export function getAllowedAgentsForBindMode(
  bindMode: TaskType[],
  allowedAgents?: TeamExecutorAgent[]
): TeamExecutorAgent[] | undefined {
  if (!requiresCodingAgentForBindMode(bindMode)) {
    return allowedAgents
  }

  if (!allowedAgents) {
    return CODING_AGENTS
  }

  return CODING_AGENTS.filter(agent => allowedAgents.includes(agent))
}
