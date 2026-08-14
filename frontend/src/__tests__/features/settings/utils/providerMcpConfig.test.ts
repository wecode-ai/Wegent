// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { MCPServer } from '@/apis/mcpProviders'
import {
  buildProviderMcpConfig,
  getProviderMcpServerKey,
  migrateLegacyProviderMcpConfig,
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
  it.each([
    ['@weibo/imagedLogMcpServer', 'imagedLogMcpServer'],
    ['provider/my-coffee', 'my-coffee'],
    ['provider/group/my-coffee', 'group-my-coffee'],
    ['plain_server', 'plain_server'],
  ])('creates an editable key for server ID %s', (serverId, expected) => {
    expect(getProviderMcpServerKey(serverId)).toBe(expected)
  })

  it('migrates URL-encoded marketplace keys already saved on Bots', () => {
    expect(
      migrateLegacyProviderMcpConfig({
        '%40weibo%2FimagedLogMcpServer': {
          type: 'streamable-http',
          url: 'http://g-mcp',
        },
      })
    ).toEqual({
      imagedLogMcpServer: {
        type: 'streamable-http',
        url: 'http://g-mcp',
      },
    })
  })

  it('uses the provider server key when building a config', () => {
    const config = buildProviderMcpConfig(createServer('@weibo/imagedLogMcpServer'))

    expect(Object.keys(config)).toEqual(['imagedLogMcpServer'])
  })
})
