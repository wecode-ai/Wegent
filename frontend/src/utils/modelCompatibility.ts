// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider identifier used to filter LLM models compatible with a given
 * agent runtime. Drives the model dropdown in task/subscription editors.
 */
export type CompatibleProvider = 'openai' | 'claude' | 'anthropic'

/**
 * Resolve which model provider is compatible with a given agent type.
 *
 * Mapping (case-insensitive):
 * - `'agno'`                       → `['openai']`
 * - `'claude'` / `'claudecode'`    → `['claude', 'anthropic']`
 * - any other non-empty string     → `null`
 * - `null` / `undefined` / `''`    → `null`
 *
 * @param agentType - The agent's `agent_type` field, typically from a Team
 * @returns Compatible provider identifiers, or `null` if no mapping applies
 *
 * @example
 * getCompatibleProviderFromAgentType('Agno')        // ['openai']
 * getCompatibleProviderFromAgentType('ClaudeCode')  // ['claude', 'anthropic']
 * getCompatibleProviderFromAgentType('dify')        // null
 * getCompatibleProviderFromAgentType(null)          // null
 */
export function getCompatibleProviderFromAgentType(
  agentType?: string | null
): CompatibleProvider[] | null {
  if (!agentType) return null
  const normalized = agentType.toLowerCase()
  if (normalized === 'agno') return ['openai']
  if (normalized === 'claude' || normalized === 'claudecode') {
    return ['claude', 'anthropic']
  }
  return null
}
