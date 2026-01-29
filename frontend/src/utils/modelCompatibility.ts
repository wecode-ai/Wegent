// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type CompatibleProvider = 'openai' | 'claude'

export function getCompatibleProviderFromAgentType(
  agentType?: string | null
): CompatibleProvider | null {
  if (!agentType) return null
  const normalized = agentType.toLowerCase()
  if (normalized === 'agno') return 'openai'
  if (normalized === 'claude' || normalized === 'claudecode') return 'claude'
  return null
}
