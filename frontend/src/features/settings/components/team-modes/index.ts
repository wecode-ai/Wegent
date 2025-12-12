// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot } from '@/types/api';
import { UnifiedShell } from '@/apis/shells';

export { default as SoloModeEditor } from './SoloModeEditor';
export { default as PipelineModeEditor } from './PipelineModeEditor';
export { default as LeaderModeEditor } from './LeaderModeEditor';
export { default as BotTransfer } from './BotTransfer';
export * from './types';

export type TeamMode = 'solo' | 'pipeline' | 'route' | 'coordinate' | 'collaborate';

/**
 * Agent types supported by the system
 */
export type AgentType = 'ClaudeCode' | 'Agno' | 'Dify';

/**
 * Mode to supported agent types mapping
 * - solo: All agent types (ClaudeCode, Agno, Dify)
 * - pipeline: ClaudeCode and Agno only (no Dify)
 * - route: Agno only (routing mode)
 * - coordinate: ClaudeCode and Agno (ClaudeCode uses native subagent mechanism)
 * - collaborate: Agno only (parallel collaboration mode)
 */
const MODE_AGENT_FILTER: Record<TeamMode, AgentType[] | null> = {
  solo: null, // null means all agents are allowed
  pipeline: ['ClaudeCode', 'Agno'],
  route: ['Agno'],
  coordinate: ['ClaudeCode', 'Agno'],
  collaborate: ['Agno'],
};

/**
 * Get the actual shell type for a bot's shell_type
 * For custom shells, the shell_type is the shell name, but we need to check
 * the shell's shellType field to get the actual agent type (ClaudeCode, Agno, etc.)
 *
 * @param shellType - The bot's shell_type (could be shell name or shell type)
 * @param shellMap - Map of shell name to UnifiedShell object
 * @returns The actual shell type (ClaudeCode, Agno, Dify, etc.)
 */
function getActualShellType(shellType: string, shellMap: Map<string, UnifiedShell>): string {
  // First check if shellType is already a known agent type
  const knownAgentTypes: AgentType[] = ['ClaudeCode', 'Agno', 'Dify'];
  if (knownAgentTypes.includes(shellType as AgentType)) {
    return shellType;
  }

  // Otherwise, look up the shell to get its shellType
  const shell = shellMap.get(shellType);
  if (shell) {
    return shell.shellType;
  }

  // Fallback to the original shell_type if shell not found
  return shellType;
}

/**
 * Filter bots based on the selected team mode
 * @param bots - All available bots
 * @param mode - Current team mode
 * @param shells - Optional list of shells for resolving custom shell runtime types
 * @returns Filtered bots that are compatible with the mode
 */
export function getFilteredBotsForMode(
  bots: Bot[],
  mode: TeamMode,
  shells?: UnifiedShell[]
): Bot[] {
  const allowedAgents = MODE_AGENT_FILTER[mode];

  // If null, all agents are allowed
  if (allowedAgents === null) {
    return bots;
  }

  // Build shell map for quick lookup
  const shellMap = new Map<string, UnifiedShell>();
  if (shells) {
    shells.forEach(shell => {
      shellMap.set(shell.name, shell);
    });
  }

  // Filter bots by allowed agent types, resolving custom shell types
  return bots.filter(bot => {
    const actualShellType = getActualShellType(bot.shell_type, shellMap);
    return allowedAgents.includes(actualShellType as AgentType);
  });
}
