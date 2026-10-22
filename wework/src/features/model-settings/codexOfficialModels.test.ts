import { describe, expect, test } from 'vitest'
import { normalizeCodexOfficialModelList } from './codexOfficialModels'

describe('codexOfficialModels', () => {
  test('preserves provider and model order from Codex', () => {
    const models = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'custom',
          type: 'provider',
          data: [{ model: 'zeta' }, { model: 'alpha' }],
        },
        {
          id: 'openai',
          data: [{ model: 'gpt-5.4' }, { model: 'gpt-5.6-sol' }, { model: 'gpt-5.5' }],
        },
      ],
    })

    expect(models.providers.map(provider => provider.id)).toEqual(['custom', 'openai'])
    expect(models.models.map(model => model.modelId)).toEqual([
      'zeta',
      'alpha',
      'gpt-5.4',
      'gpt-5.6-sol',
      'gpt-5.5',
    ])
  })

  test('uses display names from Codex without model-specific presentation rules', () => {
    const result = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'openai',
          displayName: 'CodeX',
          type: 'official',
          current: true,
          available: true,
          data: [
            {
              id: 'gpt-6.1-sol',
              model: 'gpt-6.1-sol',
              displayName: 'GPT-6.1-Sol',
            },
            {
              id: 'future-codex-model',
              model: 'future-codex-model',
              displayName: 'Future Codex Model',
            },
          ],
        },
      ],
    })

    expect(result.models.map(model => model.displayName)).toEqual([
      'GPT-6.1-Sol',
      'Future Codex Model',
    ])
  })

  test('accepts visible Codex models dynamically and excludes every hidden model', () => {
    const result = normalizeCodexOfficialModelList({
      data: [
        { model: 'future-codex-model' },
        { model: 'gpt-5.2', hidden: true },
        { model: 'gpt-5.3-codex-spark' },
        { model: 'gpt-5.4-mini' },
        { model: 'gpt-5.4' },
        { model: 'gpt-5.5' },
        { model: 'gpt-5.6-luna' },
        { model: 'gpt-5.6-terra' },
        { model: 'gpt-5.6-sol' },
        { model: 'gpt-6-luna' },
        { model: 'gpt-6-sol' },
        { model: 'gpt-6-astra', hidden: true },
      ],
    })

    expect(result.models.map(model => model.modelId)).toEqual([
      'future-codex-model',
      'gpt-5.3-codex-spark',
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-6-luna',
      'gpt-6-sol',
    ])
  })

  test('preserves the supported reasoning effort sequence advertised by Codex', () => {
    const result = normalizeCodexOfficialModelList({
      data: [
        {
          id: 'gpt-5.6-sol',
          model: 'gpt-5.6-sol',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'medium' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'max' },
            { reasoningEffort: 'ultra' },
          ],
          defaultReasoningEffort: 'low',
        },
      ],
    })

    expect(result.models[0]).toMatchObject({
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    })
  })
})
