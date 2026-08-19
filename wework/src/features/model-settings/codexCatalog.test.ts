import { describe, expect, test } from 'vitest'
import { builtinCodexCatalogModel, codexCatalogModelIdForUpstream } from './codexCatalog'

describe('codexCatalog', () => {
  test('resolves exact upstream model metadata for the matching API format', () => {
    expect(codexCatalogModelIdForUpstream([' DeepSeek-V4-Pro '], 'openai-responses')).toBe(
      'wework-deepseek-v4-pro'
    )
  })

  test('does not resolve metadata for an incompatible API format', () => {
    expect(
      codexCatalogModelIdForUpstream(['deepseek-v4-pro'], 'openai-chat-completions')
    ).toBeNull()
  })

  test('resolves a declared upstream model fragment', () => {
    expect(
      codexCatalogModelIdForUpstream(['moonshot-kimi-k2.7-code-highspeed'], 'openai-responses')
    ).toBe('wework-kimi-k2-7')
  })

  test('resolves a declared provider-specific model alias', () => {
    expect(codexCatalogModelIdForUpstream(['k3'], 'openai-chat-completions')).toBe('wework-kimi-k3')
    expect(codexCatalogModelIdForUpstream(['kimi-for-coding'], 'openai-chat-completions')).toBe(
      'wework-kimi-k2-7'
    )
  })

  test('returns built-in catalog capabilities by slug', () => {
    expect(builtinCodexCatalogModel('wework-deepseek-v4-flash')).toMatchObject({
      default_reasoning_level: 'high',
      input_modalities: ['text'],
    })
  })
})
