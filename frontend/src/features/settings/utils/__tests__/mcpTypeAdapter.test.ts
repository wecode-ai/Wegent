// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  adaptMcpConfigForAgent,
  isValidMcpTypeForAgent,
  getSupportedMcpTypes,
} from '../mcpTypeAdapter'

describe('mcpTypeAdapter', () => {
  describe('adaptMcpConfigForAgent', () => {
    it('should handle streamable-http variations for Agno', () => {
      const testCases = [
        { input: 'streamable-http', expected: 'streamable-http' },
        { input: 'streamable_http', expected: 'streamable-http' },
        { input: 'streamableHttp', expected: 'streamable-http' },
        { input: 'streamablehttp', expected: 'streamable-http' },
        { input: 'StreamableHttp', expected: 'streamable-http' },
        { input: 'STREAMABLE_HTTP', expected: 'streamable-http' },
      ]

      testCases.forEach(({ input, expected }) => {
        const config = {
          server1: {
            type: input,
            url: 'http://example.com',
          },
        }

        const result = adaptMcpConfigForAgent(config, 'Agno')
        expect((result.server1 as Record<string, unknown>).type).toBe(expected)
      })
    })

    it('should convert http to streamable-http for Agno', () => {
      const config = {
        server1: {
          type: 'http',
          url: 'http://example.com',
        },
      }

      const result = adaptMcpConfigForAgent(config, 'Agno')
      expect((result.server1 as Record<string, unknown>).type).toBe('streamable-http')
    })

    it('should convert streamable-http to http for ClaudeCode', () => {
      const config = {
        server1: {
          type: 'streamable-http',
          url: 'http://example.com',
        },
      }

      const result = adaptMcpConfigForAgent(config, 'ClaudeCode')
      expect((result.server1 as Record<string, unknown>).type).toBe('http')
    })

    it('should handle sse and stdio types without conversion', () => {
      const config = {
        server1: { type: 'sse', url: 'http://example.com' },
        server2: { type: 'stdio', command: 'node' },
      }

      const agnoResult = adaptMcpConfigForAgent(config, 'Agno')
      expect((agnoResult.server1 as Record<string, unknown>).type).toBe('sse')
      expect((agnoResult.server2 as Record<string, unknown>).type).toBe('stdio')

      const claudeResult = adaptMcpConfigForAgent(config, 'ClaudeCode')
      expect((claudeResult.server1 as Record<string, unknown>).type).toBe('sse')
      expect((claudeResult.server2 as Record<string, unknown>).type).toBe('stdio')
    })

    it('should handle case variations', () => {
      const config = {
        server1: { type: 'SSE', url: 'http://example.com' },
        server2: { type: 'STDIO', command: 'node' },
        server3: { type: 'HTTP', url: 'http://example.com' },
      }

      const result = adaptMcpConfigForAgent(config, 'Agno')
      expect((result.server1 as Record<string, unknown>).type).toBe('sse')
      expect((result.server2 as Record<string, unknown>).type).toBe('stdio')
      expect((result.server3 as Record<string, unknown>).type).toBe('streamable-http')
    })

    it('should preserve other properties', () => {
      const config = {
        server1: {
          type: 'http',
          url: 'http://example.com',
          headers: { 'X-Custom': 'value' },
          timeout: 5000,
        },
      }

      const result = adaptMcpConfigForAgent(config, 'Agno')
      expect((result.server1 as Record<string, unknown>).url).toBe('http://example.com')
      expect((result.server1 as Record<string, unknown>).headers).toEqual({ 'X-Custom': 'value' })
      expect((result.server1 as Record<string, unknown>).timeout).toBe(5000)
    })

    it('should handle empty or null config', () => {
      expect(adaptMcpConfigForAgent({}, 'Agno')).toEqual({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(adaptMcpConfigForAgent(null as any, 'Agno')).toBeNull()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(adaptMcpConfigForAgent(undefined as any, 'Agno')).toBeUndefined()
    })

    it('should handle missing type field', () => {
      const config = {
        server1: {
          url: 'http://example.com',
        },
      }

      const result = adaptMcpConfigForAgent(config, 'Agno')
      // Should default to 'sse' when type is missing
      expect((result.server1 as Record<string, unknown>).type).toBe('sse')
    })
  })

  describe('isValidMcpTypeForAgent', () => {
    it('should validate ClaudeCode types', () => {
      expect(isValidMcpTypeForAgent('sse', 'ClaudeCode')).toBe(true)
      expect(isValidMcpTypeForAgent('http', 'ClaudeCode')).toBe(true)
      expect(isValidMcpTypeForAgent('stdio', 'ClaudeCode')).toBe(true)
      expect(isValidMcpTypeForAgent('streamable-http', 'ClaudeCode')).toBe(false)
    })

    it('should validate Agno types', () => {
      expect(isValidMcpTypeForAgent('sse', 'Agno')).toBe(true)
      expect(isValidMcpTypeForAgent('streamable-http', 'Agno')).toBe(true)
      expect(isValidMcpTypeForAgent('stdio', 'Agno')).toBe(true)
      expect(isValidMcpTypeForAgent('http', 'Agno')).toBe(false)
    })

    it('should handle type variations', () => {
      expect(isValidMcpTypeForAgent('streamableHttp', 'Agno')).toBe(true)
      expect(isValidMcpTypeForAgent('streamable_http', 'Agno')).toBe(true)
      expect(isValidMcpTypeForAgent('SSE', 'Agno')).toBe(true)
    })
  })

  describe('getSupportedMcpTypes', () => {
    it('should return ClaudeCode supported types', () => {
      const types = getSupportedMcpTypes('ClaudeCode')
      expect(types).toEqual(['sse', 'http', 'stdio'])
    })

    it('should return Agno supported types', () => {
      const types = getSupportedMcpTypes('Agno')
      expect(types).toEqual(['sse', 'streamable-http', 'stdio'])
    })
  })
})
