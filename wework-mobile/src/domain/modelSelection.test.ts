import { describe, expect, it } from 'vitest'

import {
  continuationSelection,
  defaultModel,
  defaultModelOptions,
  executionFields,
  modelLabel,
  modelSupportsSpeed,
  reasoningEfforts,
  reasoningLabel,
  resolvedReasoningEffort,
  speedLabel,
} from './modelSelection'
import type { UnifiedModel } from '@/types/runtime'
import { runnerModelCatalog } from '../../../packages/collaboration/src/agent-form/runnerModelCatalog'

function model(overrides: Partial<UnifiedModel>): UnifiedModel {
  return {
    name: 'model',
    type: 'runtime',
    provider: 'local',
    config: {},
    ...overrides,
  }
}

describe('defaultModel', () => {
  it('does not automatically select an unauthenticated Codex official model', () => {
    const unauthenticated = model({
      name: 'codex-official',
      config: { weworkModelKind: 'codex-official', codexAuthConfigured: false },
    })
    const cloud = model({
      name: 'cloud-model',
      type: 'public',
      provider: 'cloud',
      runtime: { family: 'openai.openai-responses' },
    })

    expect(defaultModel([unauthenticated, cloud])).toBe(cloud)
  })

  it('prefers an authenticated Codex official model', () => {
    const authenticated = model({
      name: 'codex-official',
      config: { weworkModelKind: 'codex-official', codexAuthConfigured: true },
    })
    const cloud = model({ name: 'cloud-model', type: 'public', provider: 'cloud' })

    expect(defaultModel([authenticated, cloud])).toBe(authenticated)
  })

  it('uses the declared high reasoning effort and cloud execution identity', () => {
    const cloud = model({
      name: 'wework-gpt-5.6-sol',
      type: 'public',
      provider: 'cloud',
      namespace: 'default',
      resourceUserId: 42,
      contextWindow: 1_000_000,
      maxOutputTokens: 96_000,
      runtime: { family: 'openai.openai-responses' },
      config: {
        ui: {
          reasoningEfforts: ['low', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
        },
      },
    })

    const options = defaultModelOptions(cloud)
    expect(options).toEqual({ reasoning: 'high' })
    expect(reasoningLabel(options.reasoning)).toBe('高')
    expect(executionFields(cloud, options)).toEqual({
      modelId: 'wework-gpt-5.6-sol',
      modelType: 'public',
      modelOptions: {
        reasoning: 'high',
        collaborationMode: 'default',
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '42',
        weworkCloudModelUpstreamApiFormat: 'openai-responses',
        weworkCloudModelContextWindow: '1000000',
        weworkCloudModelMaxOutputTokens: '96000',
      },
    })
  })

  it('persists standard speed only for models that expose the speed control', () => {
    const fastModel = model({
      config: {
        ui: {
          family: 'gpt',
          reasoningEfforts: ['low', 'high'],
          controls: { speed: true },
        },
      },
    })

    expect(modelSupportsSpeed(fastModel)).toBe(true)
    expect(defaultModelOptions(fastModel)).toEqual({ reasoning: 'high', speed: 'standard' })
    expect(speedLabel('standard')).toBe('标准')
    expect(speedLabel('fast')).toBe('快速')
  })

  it.each(['openai', 'custom-provider'])(
    'preserves native %s fast speed and execution identity for creation and continuation',
    provider => {
      const [{ model: nativeModel }] = runnerModelCatalog(
        [
          {
            runtime: 'codex',
            provider,
            model_id: 'future-native-model',
            local_model_id: 'future-native-model',
            label: 'Future native model',
            account_label: 'Device account',
            is_default: true,
            default_reasoning_effort: 'medium',
            supported_reasoning_efforts: ['low', 'medium', 'high'],
          },
        ],
        [],
        'codex'
      )

      expect(modelSupportsSpeed(nativeModel)).toBe(true)
      expect(defaultModelOptions(nativeModel).speed).toBe('standard')
      const fields = executionFields(nativeModel, { speed: 'fast', reasoning: 'high' })
      expect(fields).toMatchObject({
        modelId: 'future-native-model',
        modelType: 'runtime',
        modelOptions: { speed: 'fast', reasoning: 'high', runnerModelProvider: provider },
      })
      expect(continuationSelection(fields)).toMatchObject({
        modelName: 'future-native-model',
        modelType: 'runtime',
        options: { speed: 'fast', reasoning: 'high', runnerModelProvider: provider },
      })
      expect(executionFields(nativeModel, { speed: 'invalid-tier' }).modelOptions.speed).toBe(
        'standard'
      )
    }
  )

  it.each([
    { family: 'gpt' },
    { family: 'gpt', controls: [] },
    { family: 'gpt', controls: { speed: false } },
    { family: 'gpt', controls: { speed: { enabled: false } } },
    { family: 'claude', controls: ['speed'] },
  ])('keeps unsupported or disabled speed unavailable: %j', ui => {
    const unsupported = model({ config: { ui } })

    expect(modelSupportsSpeed(unsupported)).toBe(false)
    expect(defaultModelOptions(unsupported)).not.toHaveProperty('speed')
    const fields = executionFields(unsupported, { speed: 'fast' })
    expect(fields.modelOptions).not.toHaveProperty('speed')
    expect(continuationSelection(fields).options).not.toHaveProperty('speed')
  })

  it('uses the standard reasoning control when a model interface does not declare efforts', () => {
    const interfaceModel = model({
      name: 'deepseek-v4-flash',
      config: {
        weworkModelKind: 'model-interface',
        ui: { family: 'model-interface' },
      },
    })

    expect(reasoningEfforts(interfaceModel)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(resolvedReasoningEffort(interfaceModel, undefined)).toBe('high')
    expect(defaultModelOptions(interfaceModel)).toEqual({ reasoning: 'high' })
  })

  it('respects an explicitly empty model-interface reasoning declaration', () => {
    const interfaceModel = model({
      config: {
        weworkModelKind: 'model-interface',
        ui: { family: 'model-interface', reasoningEfforts: [] },
      },
    })

    expect(reasoningEfforts(interfaceModel)).toEqual([])
    expect(resolvedReasoningEffort(interfaceModel, 'high')).toBeUndefined()
  })

  it('preserves the complete PC model label', () => {
    expect(
      modelLabel(
        model({
          displayName: 'GPT 5.6 Sol',
        })
      )
    ).toBe('GPT 5.6 Sol')
    expect(
      modelLabel(
        model({
          modelId: 'gpt-5.4-mini',
        })
      )
    ).toBe('gpt-5.4-mini')
  })
})
