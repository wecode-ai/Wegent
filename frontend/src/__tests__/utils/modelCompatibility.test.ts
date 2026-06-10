// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getCompatibleProviderFromAgentType } from '@/utils/modelCompatibility'

describe('getCompatibleProviderFromAgentType', () => {
  describe('null-like inputs', () => {
    it('returns null for undefined', () => {
      const result = getCompatibleProviderFromAgentType(undefined)
      expect(result).toBeNull()
    })

    it('returns null for null', () => {
      const result = getCompatibleProviderFromAgentType(null)
      expect(result).toBeNull()
    })

    it('returns null for empty string', () => {
      const result = getCompatibleProviderFromAgentType('')
      expect(result).toBeNull()
    })
  })

  describe('agno mapping', () => {
    it('maps "agno" to "openai"', () => {
      const result = getCompatibleProviderFromAgentType('agno')
      expect(result).toEqual(['openai'])
    })

    it('maps "AGNO" to "openai" (case-insensitive)', () => {
      const result = getCompatibleProviderFromAgentType('AGNO')
      expect(result).toEqual(['openai'])
    })

    it('maps "Agno" to "openai" (mixed case)', () => {
      const result = getCompatibleProviderFromAgentType('Agno')
      expect(result).toEqual(['openai'])
    })
  })

  describe('claude mapping', () => {
    it('maps "claude" to ClaudeCode-compatible providers', () => {
      const result = getCompatibleProviderFromAgentType('claude')
      expect(result).toEqual(['claude', 'anthropic'])
    })

    it('maps "claudecode" to ClaudeCode-compatible providers', () => {
      const result = getCompatibleProviderFromAgentType('claudecode')
      expect(result).toEqual(['claude', 'anthropic'])
    })

    it('maps "ClaudeCode" to ClaudeCode-compatible providers (real-world casing)', () => {
      const result = getCompatibleProviderFromAgentType('ClaudeCode')
      expect(result).toEqual(['claude', 'anthropic'])
    })
  })

  describe('unknown inputs', () => {
    it('returns null for unknown agent type "dify"', () => {
      const result = getCompatibleProviderFromAgentType('dify')
      expect(result).toBeNull()
    })

    it('returns null for provider name "openai" (not a valid agent type)', () => {
      const result = getCompatibleProviderFromAgentType('openai')
      expect(result).toBeNull()
    })

    it('returns null for whitespace-padded "  agno  " (no trim)', () => {
      const result = getCompatibleProviderFromAgentType('  agno  ')
      expect(result).toBeNull()
    })
  })
})
