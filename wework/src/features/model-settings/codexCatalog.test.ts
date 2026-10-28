import { describe, expect, test } from 'vitest'
import { builtinCodexCatalogModel, codexCatalogModelIdForUpstream } from './codexCatalog'

describe('codexCatalog', () => {
  test('resolves exact upstream model metadata', () => {
    expect(codexCatalogModelIdForUpstream([' DeepSeek-V4-Pro '])).toBe('wework-deepseek-v4-pro')
  })

  test('resolves a declared upstream model fragment', () => {
    expect(codexCatalogModelIdForUpstream(['moonshot-kimi-k2.7-code-highspeed'])).toBe(
      'wework-kimi-k2-7'
    )
  })

  test('resolves a declared provider-specific model alias', () => {
    expect(codexCatalogModelIdForUpstream(['k3'])).toBe('wework-kimi-k3')
    expect(codexCatalogModelIdForUpstream(['kimi-for-coding'])).toBe('wework-kimi-k2-7')
  })

  test('resolves the active Wework long-context models', () => {
    expect(codexCatalogModelIdForUpstream(['qwen3.8-max'])).toBe('wework-qwen-3-8-max')
    expect(codexCatalogModelIdForUpstream(['thudm-glm-5.3-flash'])).toBe('wework-glm-5-3')
    expect(codexCatalogModelIdForUpstream(['huoshan-deepseek-v4.1-flash'])).toBe(
      'wework-deepseek-v4-1-flash'
    )
    expect(codexCatalogModelIdForUpstream(['gpt-6.1-sol'])).toBe('wework-gpt-6.1-sol')
    expect(codexCatalogModelIdForUpstream(['gpt-6-astra'])).toBe('wework-gpt-6-astra')
  })

  test('returns built-in catalog capabilities by slug', () => {
    expect(builtinCodexCatalogModel('wework-deepseek-v4-flash')).toMatchObject({
      default_reasoning_level: 'high',
      input_modalities: ['text'],
    })
  })
})
