// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MCPServer } from '@/apis/mcpProviders'

export function encodeProviderMcpServerKey(serverId: string): string {
  return encodeURIComponent(serverId)
}

export function buildProviderMcpConfig(server: MCPServer): Record<string, unknown> {
  const serverKey = encodeProviderMcpServerKey(server.id)
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
