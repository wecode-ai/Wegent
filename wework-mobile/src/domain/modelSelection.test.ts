import { describe, expect, it } from 'vitest'

import {
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

  it('uses the compact Codex model label shown by the mobile picker', () => {
    expect(
      modelLabel(
        model({
          displayName: 'GPT 5.6 Sol',
        })
      )
    ).toBe('5.6 Sol')
    expect(
      modelLabel(
        model({
          modelId: 'gpt-5.4-mini',
        })
      )
    ).toBe('5.4 Mini')
  })
})
