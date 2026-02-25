// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { adaptMcpConfigForAgent, type AgentType } from './mcpTypeAdapter'

export type McpServersConfig = Record<string, unknown>

export function parseMcpConfig(mcpConfig: string): McpServersConfig {
  const trimmed = mcpConfig.trim()
  if (!trimmed) {
    return {}
  }

  const parsed = JSON.parse(trimmed)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid MCP config format')
  }

  return parsed as McpServersConfig
}

export function stringifyMcpConfig(config: McpServersConfig): string {
  if (!config || Object.keys(config).length === 0) {
    return ''
  }

  return JSON.stringify(config, null, 2)
}

/**
 * Normalize MCP servers config from one of these shapes:
 * - { mcpServers: {...} }
 * - { mcp_servers: {...} }
 * - { ...servers }
 */
export function normalizeMcpServers(
  config: McpServersConfig,
  agentType?: AgentType
): McpServersConfig {
  const servers = (config.mcpServers ?? config.mcp_servers ?? config) as McpServersConfig
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('Invalid MCP servers configuration')
  }

  const normalizedServers: McpServersConfig = {}

  Object.entries(servers).forEach(([serverName, serverValue]) => {
    if (!serverValue || typeof serverValue !== 'object' || Array.isArray(serverValue)) {
      normalizedServers[serverName] = serverValue
      return
    }

    const server = { ...(serverValue as McpServersConfig) }

    if (!server.type && server.transport) {
      server.type = server.transport
    }

    if (server.transport) {
      delete server.transport
    }

    if (!server.type) {
      server.type = 'stdio'
    }

    normalizedServers[serverName] = server
  })

  return agentType ? adaptMcpConfigForAgent(normalizedServers, agentType) : normalizedServers
}

export function mergeMcpConfigs(
  currentConfig: McpServersConfig,
  incomingConfig: McpServersConfig
): McpServersConfig {
  return {
    ...currentConfig,
    ...incomingConfig,
  }
}

export function removeMcpServer(config: McpServersConfig, serverName: string): McpServersConfig {
  const nextConfig = { ...config }
  delete nextConfig[serverName]
  return nextConfig
}
