import { describe, expect, test } from 'vitest'
import { codexModelPickerLabel, normalizeCodexOfficialModelList } from './codexOfficialModels'

describe('codexOfficialModels', () => {
  test('preserves provider order and unknown model order while applying picker order', () => {
    const models = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'custom',
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
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.4',
    ])
  })

  test('maps requested picker names in the fixed product order', () => {
    const modelIds = [
      'gpt-5.3-codex-spark',
      'gpt-5.4-mini',
      'gpt-5.4',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]
    const result = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'openai',
          displayName: 'CodeX',
          type: 'official',
          current: true,
          available: true,
          data: modelIds.map(model => ({
            id: model,
            model,
            displayName: model,
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          })),
        },
      ],
    })

    expect(result.models.map(model => codexModelPickerLabel(model.modelId))).toEqual([
      'GPT 5.6 Sol',
      'GPT 5.6 Terra',
      'GPT 5.6 Luna',
      'GPT 5.5',
      'GPT 5.4',
      'GPT 5.4 Mini',
      'GPT 5.3 Codex Spark',
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
