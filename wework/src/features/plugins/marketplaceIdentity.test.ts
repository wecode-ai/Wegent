import { describe, expect, test } from 'vitest'
import {
  isBuiltInMarketplaceId,
  isInternalDeviceMarketplaceId,
  isOpenAiOfficialMarketplaceId,
} from './marketplaceIdentity'

describe('marketplaceIdentity', () => {
  test('recognizes OpenAI official marketplace ids', () => {
    expect(isOpenAiOfficialMarketplaceId('openai-api-curated')).toBe(true)
    expect(isOpenAiOfficialMarketplaceId('openai-bundled')).toBe(true)
    expect(isOpenAiOfficialMarketplaceId('openai-curated')).toBe(true)
    expect(isOpenAiOfficialMarketplaceId('openai-curated-remote')).toBe(true)
    expect(isOpenAiOfficialMarketplaceId('openai-official')).toBe(true)
    expect(isOpenAiOfficialMarketplaceId('OpenAI-Primary-Runtime')).toBe(true)
    expect(isOpenAiOfficialMarketplaceId('awesome-codex-plugins')).toBe(false)
  })

  test('treats OpenAI official marketplaces as built-ins', () => {
    expect(isBuiltInMarketplaceId('openai-curated')).toBe(true)
    expect(isBuiltInMarketplaceId('openai-curated-remote')).toBe(true)
    expect(isBuiltInMarketplaceId('openai-official')).toBe(true)
    expect(isBuiltInMarketplaceId('awesome-codex-plugins')).toBe(false)
  })

  test('recognizes the internal wegent marketplace and other built-ins', () => {
    expect(isInternalDeviceMarketplaceId('wegent')).toBe(true)
    expect(isBuiltInMarketplaceId('wegent')).toBe(true)
    expect(isBuiltInMarketplaceId('wework-personal')).toBe(true)
    expect(isBuiltInMarketplaceId('awesome-codex-plugins')).toBe(false)
  })
})
