import { describe, expect, test } from 'vitest'
import {
  isBuiltInMarketplaceId,
  isInternalDeviceMarketplaceId,
  isOpenAiOfficialBundledMarketplaceId,
  isOpenAiOfficialMarketplaceId,
  isOpenAiOfficialRemoteMarketplaceId,
  isWegentCloudMarketplaceId,
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

  test('splits bundled OpenAI marketplaces from remote GitHub ones', () => {
    expect(isOpenAiOfficialBundledMarketplaceId('openai-bundled')).toBe(true)
    expect(isOpenAiOfficialBundledMarketplaceId('openai-primary-runtime')).toBe(true)
    expect(isOpenAiOfficialBundledMarketplaceId('openai-curated-remote')).toBe(false)
    expect(isOpenAiOfficialRemoteMarketplaceId('openai-curated-remote')).toBe(true)
    expect(isOpenAiOfficialRemoteMarketplaceId('openai-curated')).toBe(true)
    expect(isOpenAiOfficialRemoteMarketplaceId('openai-official')).toBe(true)
    expect(isOpenAiOfficialRemoteMarketplaceId('openai-api-curated')).toBe(true)
    expect(isOpenAiOfficialRemoteMarketplaceId('openai-bundled')).toBe(false)
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
    expect(isBuiltInMarketplaceId('wework')).toBe(true)
    expect(isBuiltInMarketplaceId('wework-personal')).toBe(true)
    expect(isBuiltInMarketplaceId('awesome-codex-plugins')).toBe(false)
  })

  test('treats all Wegent cloud aliases as the same built-in marketplace', () => {
    for (const id of ['default', 'wework', 'wegent', 'wegent-market', 'wegent-marketplace']) {
      expect(isWegentCloudMarketplaceId(id)).toBe(true)
      expect(isBuiltInMarketplaceId(id)).toBe(true)
    }

    expect(isWegentCloudMarketplaceId('wegent-bundled')).toBe(false)
    expect(isBuiltInMarketplaceId('wegent-bundled')).toBe(false)
  })
})
