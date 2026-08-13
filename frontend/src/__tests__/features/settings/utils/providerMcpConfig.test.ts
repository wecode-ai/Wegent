// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MCPServer } from '@/apis/mcpProviders'
import { mergeMcpConfigs } from '@/features/settings/utils/mcpConfig'
import {
  buildProviderMcpConfig,
  encodeProviderMcpServerKey,
} from '@/features/settings/utils/providerMcpConfig'

function createServer(id: string): MCPServer {
  return {
    id,
    name: id,
    description: '',
    type: 'streamable-http',
    base_url: 'https://example.test/mcp',
    is_active: true,
    provider: 'test',
  }
}

describe('providerMcpConfig', () => {
  it.each(['a/b', 'a@b', 'a_b'])('uses a reversible key for server ID %s', serverId => {
    const serverKey = encodeProviderMcpServerKey(serverId)

    expect(decodeURIComponent(serverKey)).toBe(serverId)
  })

  it('preserves configurations whose source IDs previously normalized to the same key', () => {
    const merged = mergeMcpConfigs(
      buildProviderMcpConfig(createServer('a_b')),
      buildProviderMcpConfig(createServer('a/b'))
    )

    expect(Object.keys(merged)).toEqual(['a_b', 'a%2Fb'])
  })
})
