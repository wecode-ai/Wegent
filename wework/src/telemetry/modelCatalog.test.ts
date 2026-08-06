import { describe, expect, test } from 'vitest'
import { toKnownAiProvider } from './modelCatalog'

describe('toKnownAiProvider', () => {
  test('derives the provider from the model id prefix over the configured provider string', () => {
    expect(toKnownAiProvider('moonshot-kimi-k2.7-code', 'anthropic')).toBe('moonshot')
    expect(toKnownAiProvider('moonshot-kimi-k3', 'anthropic')).toBe('moonshot')
    expect(toKnownAiProvider('deepseek-v4-flash', 'openai')).toBe('deepseek')
    expect(toKnownAiProvider('gpt-5.6-sol', 'local')).toBe('openai')
    expect(toKnownAiProvider('claude-3-7-sonnet', 'local')).toBe('anthropic')
    expect(toKnownAiProvider('gemini-2.5-pro', 'google')).toBe('google')
  })

  test('treats the official Codex catalog as openai when the model id is unrecognized', () => {
    expect(toKnownAiProvider('wework-gpt-5.6-sol', 'local', 'codex-official')).toBe('openai')
    expect(toKnownAiProvider('some-catalog-model', 'local', 'codex-official')).toBe('openai')
  })

  test('falls back to the configured provider aliases when the model id has no prefix match', () => {
    expect(toKnownAiProvider('my-custom-model', 'claude')).toBe('anthropic')
    expect(toKnownAiProvider('my-custom-model', 'openai')).toBe('openai')
    expect(toKnownAiProvider('my-custom-model', 'Kimi')).toBe('moonshot')
  })

  test('does not apply the codex-official rule to provider-configured models', () => {
    expect(toKnownAiProvider('my-custom-model', 'anthropic', 'codex-provider')).toBe('anthropic')
  })

  test('normalizes case and whitespace', () => {
    expect(toKnownAiProvider('Moonshot-Kimi-K3 ', 'anthropic')).toBe('moonshot')
    expect(toKnownAiProvider('my-custom-model', ' Claude ')).toBe('anthropic')
  })

  test('falls through to other for unknown values', () => {
    expect(toKnownAiProvider(null, null)).toBe('other')
    expect(toKnownAiProvider('my-custom-model', 'my-vendor')).toBe('other')
    expect(toKnownAiProvider('', '')).toBe('other')
  })
})
