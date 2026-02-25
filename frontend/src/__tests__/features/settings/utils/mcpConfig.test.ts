// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  mergeMcpConfigs,
  normalizeMcpServers,
  parseMcpConfig,
  removeMcpServer,
  stringifyMcpConfig,
} from '../../../../features/settings/utils/mcpConfig'

describe('mcpConfig', () => {
  describe('parseMcpConfig', () => {
    it('returns empty object for empty input', () => {
      expect(parseMcpConfig('')).toEqual({})
      expect(parseMcpConfig('   ')).toEqual({})
    })

    it('parses valid object json', () => {
      const parsed = parseMcpConfig('{"server": {"type": "sse"}}')
      expect(parsed).toEqual({ server: { type: 'sse' } })
    })

    it('throws for non-object json', () => {
      expect(() => parseMcpConfig('[]')).toThrow('Invalid MCP config format')
      expect(() => parseMcpConfig('1')).toThrow('Invalid MCP config format')
    })
  })

  describe('normalizeMcpServers', () => {
    it('supports wrapped config and normalizes transport', () => {
      const normalized = normalizeMcpServers({
        mcpServers: {
          demo: {
            transport: 'streamable_http',
            url: 'http://example.com',
          },
        },
      })

      expect(normalized).toEqual({
        demo: {
          type: 'streamable_http',
          url: 'http://example.com',
        },
      })
      expect((normalized.demo as Record<string, unknown>).transport).toBeUndefined()
    })

    it('adapts type for target agent', () => {
      const normalized = normalizeMcpServers(
        {
          demo: {
            type: 'http',
            url: 'http://example.com',
          },
        },
        'Agno'
      )

      expect((normalized.demo as Record<string, unknown>).type).toBe('streamable-http')
    })
  })

  describe('config mutations', () => {
    it('merges and removes servers', () => {
      const merged = mergeMcpConfigs({ existing: { type: 'sse' } }, { imported: { type: 'stdio' } })

      expect(merged).toEqual({
        existing: { type: 'sse' },
        imported: { type: 'stdio' },
      })

      expect(removeMcpServer(merged, 'existing')).toEqual({
        imported: { type: 'stdio' },
      })
    })

    it('stringifies empty config as empty string', () => {
      expect(stringifyMcpConfig({})).toBe('')
      expect(stringifyMcpConfig({ demo: { type: 'sse' } })).toContain('"demo"')
    })
  })
})
