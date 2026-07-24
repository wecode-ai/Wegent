import { describe, expect, it } from 'vitest'
import type { UnifiedModel } from '@/types/api'
import {
  getCloudModelUpstreamApiFormat,
  resolveModelExecutionSelection,
  supportsCloudExecution,
} from './modelExecution'

function buildUnifiedModel(config?: Record<string, unknown>): UnifiedModel {
  return {
    name: 'test-model',
    type: 'public',
    config,
  } as UnifiedModel
}

describe('modelExecution', () => {
  it('uses the canonical model identity for execution', () => {
    expect(
      resolveModelExecutionSelection({
        name: 'claude-sonnet',
        type: 'public',
      } as UnifiedModel)
    ).toEqual({
      modelName: 'claude-sonnet',
      modelType: 'public',
    })
  })

  describe('supportsCloudExecution', () => {
    it('returns true for Responses protocol models', () => {
      expect(
        supportsCloudExecution(
          buildUnifiedModel({ protocol: 'openai-responses', apiFormat: 'responses' })
        )
      ).toBe(true)
    })

    it('returns true for OpenAI Chat Completions protocol models', () => {
      expect(
        supportsCloudExecution(
          buildUnifiedModel({ protocol: 'openai', apiFormat: 'chat/completions' })
        )
      ).toBe(true)
    })

    it('returns true for Anthropic Messages protocol models', () => {
      expect(supportsCloudExecution(buildUnifiedModel({ protocol: 'claude' }))).toBe(true)
    })

    it('returns false for unsupported protocols', () => {
      expect(supportsCloudExecution(buildUnifiedModel({ protocol: 'gemini' }))).toBe(false)
    })
  })

  describe('getCloudModelUpstreamApiFormat', () => {
    it('detects openai-responses', () => {
      expect(
        getCloudModelUpstreamApiFormat(
          buildUnifiedModel({ protocol: 'openai-responses', apiFormat: 'responses' })
        )
      ).toBe('openai-responses')
    })

    it('detects openai-chat-completions from protocol and apiFormat', () => {
      expect(
        getCloudModelUpstreamApiFormat(
          buildUnifiedModel({ protocol: 'openai', apiFormat: 'chat/completions' })
        )
      ).toBe('openai-chat-completions')
    })

    it('detects anthropic-messages from protocol', () => {
      expect(getCloudModelUpstreamApiFormat(buildUnifiedModel({ protocol: 'claude' }))).toBe(
        'anthropic-messages'
      )
    })

    it('returns null for unsupported protocols', () => {
      expect(getCloudModelUpstreamApiFormat(buildUnifiedModel({ protocol: 'gemini' }))).toBeNull()
    })
  })
})
