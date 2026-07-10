import { describe, expect, test } from 'vitest'
import { normalizeCodexOfficialModelList } from './codexOfficialModels'

describe('normalizeCodexOfficialModelList', () => {
  test('preserves the provider and model order returned by Codex', () => {
    const models = normalizeCodexOfficialModelList({
      providers: [
        {
          id: 'custom',
          data: [{ model: 'zeta' }, { model: 'alpha' }],
        },
        {
          id: 'openai',
          data: [{ model: 'gpt-5.5' }, { model: 'gpt-5.6' }],
        },
      ],
    })

    expect(models.providers.map(provider => provider.id)).toEqual(['custom', 'openai'])
    expect(models.models.map(model => model.modelId)).toEqual([
      'zeta',
      'alpha',
      'gpt-5.5',
      'gpt-5.6',
    ])
  })
})
