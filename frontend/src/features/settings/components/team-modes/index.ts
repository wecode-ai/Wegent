// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot } from '@/types/api';

export { default as SoloModeEditor } from './SoloModeEditor';
export { default as PipelineModeEditor } from './PipelineModeEditor';
export { default as LeaderModeEditor } from './LeaderModeEditor';
export { default as BotTransfer } from './BotTransfer';
export * from './types';

export type TeamMode = 'solo' | 'pipeline' | 'route' | 'coordinate' | 'collaborate' | 'async';

/**
 * Agent types supported by the system
 */
export type AgentType = 'ClaudeCode' | 'Agno' | 'Dify';

/**
 * Mode to supported agent types mapping
 * - solo: All agent types (ClaudeCode, Agno, Dify)
 * - pipeline: ClaudeCode and Agno only (no Dify)
 * - route/coordinate/collaborate: Agno only (multi-agent collaboration modes)
 * - async: ClaudeCode only (external event-driven multi-turn conversation)
 */
const MODE_AGENT_FILTER: Record<TeamMode, AgentType[] | null> = {
  solo: null, // null means all agents are allowed
  pipeline: ['ClaudeCode', 'Agno'],
  route: ['Agno'],
  coordinate: ['Agno'],
  collaborate: ['Agno'],
  async: ['ClaudeCode'], // async mode only supports ClaudeCode for single-bot external event-driven workflow
};

/**
 * Filter bots based on the selected team mode
 * @param bots - All available bots
 * @param mode - Current team mode
 * @returns Filtered bots that are compatible with the mode
 */
export function getFilteredBotsForMode(bots: Bot[], mode: TeamMode): Bot[] {
  const allowedAgents = MODE_AGENT_FILTER[mode];

  // If null, all agents are allowed
  if (allowedAgents === null) {
    return bots;
  }

  // Filter bots by allowed agent types
  return bots.filter(bot => allowedAgents.includes(bot.agent_name as AgentType));
}
