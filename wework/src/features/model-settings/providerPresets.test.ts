import { describe, expect, it } from 'vitest'
import { createPresetProviderModel, detectProviderPreset } from './providerPresets'
import { LOCAL_MODEL_PROVIDER_PROFILES } from './localModelProviders'
import { validateModelConfiguration } from '../../../electron/src/host/model-configuration-validation'

describe('provider model creation defaults', () => {
  it.each(LOCAL_MODEL_PROVIDER_PROFILES.filter(profile => profile.id !== 'custom'))(
    'recognizes the unchanged $id endpoint and retains explicit custom discovery options',
    profile => {
      const provider = {
        id: 'service',
        name: 'Service',
        base_url: `${profile.baseUrl}/`,
        api_format: profile.apiFormat,
        request_path: profile.requestPath,
        models_path: profile.modelsPath,
        models_api_key_header: profile.modelsApiKeyHeader,
        models: [],
      }
      expect(detectProviderPreset(provider)).toBe(profile.id)
      expect(detectProviderPreset({ ...provider, base_url: 'https://custom.example/v1' })).toBe(
        'custom'
      )
      expect(detectProviderPreset({ ...provider, models_path: '/custom-models' })).toBe('custom')
    }
  )

  it.each(['openai-responses', 'openai-chat-completions', 'anthropic-messages'] as const)(
    'creates a valid custom model inheriting %s',
    apiFormat => {
      const model = createPresetProviderModel('custom', 'upstream', {
        apiFormat,
        createId: () => 'stable',
      })
      expect(model.id).toBe('stable')
      expect(model.tool_profile).toBe(apiFormat === 'openai-responses' ? 'custom' : 'function')
      expect(model.api_format).toBeUndefined()
      expect(() =>
        validateModelConfiguration({
          version: 1,
          providers: [
            {
              id: 'service',
              name: 'Service',
              base_url: 'https://example.test/v1',
              api_format: apiFormat,
              models: [model],
            },
          ],
        })
      ).not.toThrow()
    }
  )
  it('preserves preset-specific capability defaults', () => {
    const model = createPresetProviderModel('kimi-coding', 'k3', { createId: () => 'stable' })
    expect(model).toMatchObject({
      id: 'stable',
      model_id: 'k3',
      provider_profile_id: 'kimi-coding',
      tool_profile: 'function',
      context_window: 262144,
    })
    expect(model.catalog_entry?.input_modalities).toContain('image')
  })
})
