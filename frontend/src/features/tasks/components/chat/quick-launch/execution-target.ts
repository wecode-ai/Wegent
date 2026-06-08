// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'

const CLAUDE_CODE_AGENT_TYPES = new Set(['claude', 'claudecode'])
const CLAUDE_CODE_SHELL_TYPE = 'claudecode'
const CLAUDE_COMPATIBLE_PROTOCOLS = ['claude', 'anthropic']

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return normalized || null
}

function isClaudeCompatibleProtocol(protocol: string): boolean {
  return CLAUDE_COMPATIBLE_PROTOCOLS.some(compatibleProtocol =>
    protocol.includes(compatibleProtocol)
  )
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function isPredefinedBoundModelConfig(config: Record<string, unknown>): boolean {
  return Boolean(normalizeString(config.bind_model))
}

function getModelProtocol(config: Record<string, unknown>): string | null {
  const protocol = normalizeString(config.protocol)
  if (protocol) {
    return protocol
  }

  const provider = normalizeString(config.provider)
  if (provider) {
    return provider
  }

  const model = normalizeString(config.model)
  if (model) {
    return model
  }

  const env = getRecord(config.env)
  if (!env) {
    return null
  }

  return normalizeString(env.model) ?? normalizeString(env.provider)
}

function isClaudeCodeTeam(team: Team): boolean {
  const agentType = normalizeString(team.agent_type)
  if (agentType && CLAUDE_CODE_AGENT_TYPES.has(agentType)) {
    return true
  }

  const bots = team.bots ?? []
  if (bots.length === 0) {
    return false
  }

  return bots.some(bot => normalizeString(bot.bot?.shell_type) === CLAUDE_CODE_SHELL_TYPE)
}

function hasNonClaudeProtocolModel(team: Team): boolean {
  return (team.bots ?? []).some(bot => {
    const config = getRecord(bot.bot?.agent_config)
    if (!config || isPredefinedBoundModelConfig(config)) {
      return false
    }

    const protocol = getModelProtocol(config)
    if (!protocol) {
      return false
    }

    return !isClaudeCompatibleProtocol(protocol)
  })
}

export function shouldClearDeviceSelectionForQuickLauncher(team: Team): boolean {
  if (!isClaudeCodeTeam(team)) {
    return true
  }

  return hasNonClaudeProtocolModel(team)
}
