import { describe, expect, test } from 'vitest'
import { defaultNewChatModelSelection, selectedModelExecutionFields } from './runtimeModelSelection'
import type { UnifiedModel } from '@/types/api'

describe('runtimeModelSelection', () => {
  test('sends default collaboration mode when plan mode is not selected', () => {
    expect(selectedModelExecutionFields(null, {})).toEqual({
      modelOptions: { collaborationMode: 'default' },
    })
  })

  test('keeps model options when the default model is selected', () => {
    expect(selectedModelExecutionFields(null, { collaborationMode: 'plan' })).toEqual({
      modelOptions: { collaborationMode: 'plan' },
    })
  })

  test('chooses default new chat model by Codex priority', () => {
    const officialWithoutAuth: UnifiedModel = {
      name: 'gpt-5.5',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'codex-official',
        codexAuthConfigured: false,
        ui: { family: 'codex-official', controls: ['speed'] },
      },
    }
    const officialWithAuth: UnifiedModel = {
      ...officialWithoutAuth,
      config: {
        ...officialWithoutAuth.config,
        codexAuthConfigured: true,
      },
    }
    const providerModel: UnifiedModel = {
      name: 'Doubao-Seed-2.0-pro-260215',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'codex-provider',
        codexProviderId: 'wecode-openai',
        codexProviderName: 'wecode openai',
        ui: { family: 'codex-provider', controls: ['speed'] },
      },
    }
    const interfaceModel: UnifiedModel = {
      name: 'local-model:ollama',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'model-interface',
        ui: { family: 'model-interface', controls: ['speed'] },
      },
    }
    const cloudModel: UnifiedModel = {
      name: 'cloud-gpt',
      type: 'public',
      provider: 'cloud',
      config: {
        ui: { family: 'gpt' },
      },
    }

    expect(
      defaultNewChatModelSelection([officialWithAuth, providerModel, interfaceModel, cloudModel])
    ).toMatchObject({
      modelName: 'gpt-5.5',
      modelType: 'runtime',
    })
    expect(
      defaultNewChatModelSelection([officialWithoutAuth, providerModel, interfaceModel, cloudModel])
    ).toMatchObject({
      modelName: 'Doubao-Seed-2.0-pro-260215',
      modelType: 'runtime',
    })
    expect(
      defaultNewChatModelSelection([officialWithoutAuth, interfaceModel, cloudModel])
    ).toMatchObject({
      modelName: 'local-model:ollama',
      modelType: 'runtime',
    })
    expect(defaultNewChatModelSelection([officialWithoutAuth, cloudModel])).toMatchObject({
      modelName: 'cloud-gpt',
      modelType: 'public',
    })
  })

  test('passes Codex provider id as hidden execution options', () => {
    const providerModel: UnifiedModel = {
      name: 'Doubao-Seed-2.0-pro-260215',
      type: 'runtime',
      provider: 'local',
      config: {
        weworkModelKind: 'codex-provider',
        codexProviderId: 'wecode-openai',
        codexProviderName: 'wecode openai',
        ui: { family: 'codex-provider', controls: ['speed'] },
      },
    }

    expect(
      selectedModelExecutionFields(providerModel, { speed: 'fast', reasoning: 'extra_high' })
    ).toEqual({
      modelId: 'Doubao-Seed-2.0-pro-260215',
      modelType: 'runtime',
      modelOptions: {
        speed: 'fast',
        reasoning: 'xhigh',
        collaborationMode: 'default',
        codexProviderId: 'wecode-openai',
        codexProviderName: 'wecode openai',
      },
    })
  })
})
