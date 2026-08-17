// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MCPServer } from '@/apis/mcpProviders'

export function matchesMcpServerKeyword(server: MCPServer, keyword: string): boolean {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase()
  if (!normalizedKeyword) return true

  return [server.name, server.description, server.provider, ...(server.tags || [])]
    .filter(Boolean)
    .some(value => value?.toLocaleLowerCase().includes(normalizedKeyword))
}
