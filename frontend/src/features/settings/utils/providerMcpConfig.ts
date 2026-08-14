// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MCPServer } from '@/apis/mcpProviders'

const INVALID_MCP_SERVER_NAME_CHARS = /[^a-zA-Z0-9_\-.:]+/g

export function getProviderMcpServerKey(serverId: string): string {
  const separatorIndex = serverId.indexOf('/')
  const serverKey = separatorIndex >= 0 ? serverId.slice(separatorIndex + 1) : serverId
  return serverKey.replace(INVALID_MCP_SERVER_NAME_CHARS, '-').replace(/^-+|-+$/g, '') || 'mcp'
}

export function migrateLegacyProviderMcpServerKey(serverKey: string): string {
  if (!serverKey.includes('%')) return serverKey

  try {
    const decodedKey = decodeURIComponent(serverKey)
    return decodedKey.includes('/') ? getProviderMcpServerKey(decodedKey) : serverKey
  } catch {
    return serverKey
  }
}

export function migrateLegacyProviderMcpConfig(
  config: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([serverKey, serverConfig]) => [
      migrateLegacyProviderMcpServerKey(serverKey),
      serverConfig,
    ])
  )
}

export function buildProviderMcpConfig(server: MCPServer): Record<string, unknown> {
  const serverKey = getProviderMcpServerKey(server.id)
  const serverConfig: Record<string, unknown> = {
    type: server.type === 'streamableHttp' ? 'streamable-http' : server.type,
  }

  if (server.base_url) serverConfig.url = server.base_url
  if (server.command) serverConfig.command = server.command
  if (server.args?.length) serverConfig.args = server.args
  if (server.env && Object.keys(server.env).length > 0) serverConfig.env = server.env
  if (server.headers && Object.keys(server.headers).length > 0) {
    serverConfig.headers = server.headers
  }

  return {
    [serverKey]: serverConfig,
  }
}
