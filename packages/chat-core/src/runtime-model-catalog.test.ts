import { describe, expect, test } from 'vitest'
import type { CodexOfficialModel } from './codex-official-models'
import { codexRuntimeModels } from './runtime-model-catalog'

function officialModel(
  modelId: string,
  {
    isDefault = false,
    defaultReasoningEffort = 'medium',
  }: {
    isDefault?: boolean
    defaultReasoningEffort?: string
  } = {}
): CodexOfficialModel {
  return {
    id: modelId,
    displayName: modelId,
    modelId,
    providerId: 'openai',
    providerName: 'OpenAI',
    providerType: 'official',
    providerCurrent: true,
    description: null,
    hidden: false,
    isDefault,
    defaultReasoningEffort,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    supportsFastMode: false,
  }
}

describe('codexRuntimeModels', () => {
  test('uses the current ChatGPT production slider preset', () => {
    const models = codexRuntimeModels(
      [
        officialModel('gpt-6-luna'),
        officialModel('gpt-6.1-sol', {
          isDefault: true,
          defaultReasoningEffort: 'medium',
        }),
        officialModel('gpt-6-astra'),
      ],
      null,
      true
    )
    const defaultModel = models.find(model => model.config?.codexIsDefault === true)

    expect(defaultModel?.config?.ui).toMatchObject({
      defaultModel: true,
      sliderModelsConfig: {
        defaultPreset: 'recommended',
        presets: [
          {
            name: 'recommended',
            label: '推荐',
            description: '推荐模型集',
            models: [
              { model: 'gpt-6-luna', reasoning_effort: 'high' },
              { model: 'gpt-6.1-sol', reasoning_effort: 'low' },
              { model: 'gpt-6.1-sol', reasoning_effort: 'medium' },
              { model: 'gpt-6-astra', reasoning_effort: 'low' },
              { model: 'gpt-6-astra', reasoning_effort: 'medium' },
              { model: 'gpt-6-astra', reasoning_effort: 'xhigh' },
            ],
          },
        ],
      },
    })
  })
})
