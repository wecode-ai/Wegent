// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getCompatibleProviderFromAgentType } from '@/utils/modelCompatibility'

describe('getCompatibleProviderFromAgentType', () => {
  describe('null-like inputs', () => {
    it('returns null for undefined', () => {
      expect(getCompatibleProviderFromAgentType(undefined)).toBeNull()
    })

    it('returns null for null', () => {
      expect(getCompatibleProviderFromAgentType(null)).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(getCompatibleProviderFromAgentType('')).toBeNull()
    })
  })

  describe('agno mapping', () => {
    it('maps "agno" to "openai"', () => {
      expect(getCompatibleProviderFromAgentType('agno')).toBe('openai')
    })

    it('maps "AGNO" to "openai" (case-insensitive)', () => {
      expect(getCompatibleProviderFromAgentType('AGNO')).toBe('openai')
    })

    it('maps "Agno" to "openai" (mixed case)', () => {
      expect(getCompatibleProviderFromAgentType('Agno')).toBe('openai')
    })
  })

  describe('claude mapping', () => {
    it('maps "claude" to "claude"', () => {
      expect(getCompatibleProviderFromAgentType('claude')).toBe('claude')
    })

    it('maps "claudecode" to "claude"', () => {
      expect(getCompatibleProviderFromAgentType('claudecode')).toBe('claude')
    })

    it('maps "ClaudeCode" to "claude" (real-world casing)', () => {
      expect(getCompatibleProviderFromAgentType('ClaudeCode')).toBe('claude')
    })
  })

  describe('unknown inputs', () => {
    it('returns null for unknown agent type "dify"', () => {
      expect(getCompatibleProviderFromAgentType('dify')).toBeNull()
    })

    it('returns null for provider name "openai" (not a valid agent type)', () => {
      expect(getCompatibleProviderFromAgentType('openai')).toBeNull()
    })

    it('returns null for whitespace-padded "  agno  " (no trim)', () => {
      expect(getCompatibleProviderFromAgentType('  agno  ')).toBeNull()
    })
  })
})
