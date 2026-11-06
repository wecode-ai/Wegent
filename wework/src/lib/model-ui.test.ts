// @vitest-environment node

import type { UnifiedModel } from '@/types/api'
import { describe, expect, test } from 'vitest'
import {
  areModelsProtocolCompatible,
  getControlsForModel,
  getModelCompatibilityFamily,
  groupModelsByFamily,
  inferModelFamily,
  isCodexOfficialModel,
  isModelInterfaceModel,
  isSameModelSelection,
  isSupportedModelFamily,
  MODEL_SELECTION_OPTION,
  normalizeModelOptions,
} from './model-ui'

describe('model-ui', () => {
  test.each(['model'])(
    'preserves model selection intent through option normalization (%s)',
    selection => {
      const model: UnifiedModel = {
        name: 'gpt-6.1-sol',
        type: 'runtime',
        config: { ui: { family: 'codex-official' } },
      }
      expect(normalizeModelOptions(model, { [MODEL_SELECTION_OPTION]: selection })).toMatchObject({
        [MODEL_SELECTION_OPTION]: selection,
      })
    }
  )

  test('treats same-name Codex models from different providers as different selections', () => {
    const official: UnifiedModel = {
      name: 'gpt-5.6-luna',
      type: 'runtime',
      config: { codexProviderId: 'openai' },
    }
    const provider: UnifiedModel = {
      name: 'gpt-5.6-luna',
      type: 'runtime',
      config: { codexProviderId: 'wework-e2e' },
    }

    expect(isSameModelSelection(official, provider)).toBe(false)
    expect(isSameModelSelection(provider, { ...provider })).toBe(true)
  })

  test('groups models by identity instead of compatible provider protocol', () => {
    const deepseekModel: UnifiedModel = {
      name: 'ali-deepseek-v4-flash(公网)',
      type: 'public',
      displayName: '公网:ali-deepseek-v4-flash',
      provider: 'claude',
      modelId: 'ali-deepseek-v4-flash',
    }
    const qwenModel: UnifiedModel = {
      name: 'ali-qwen3.5-plus(公网)',
      type: 'public',
      displayName: '公网:qwen3.5-plus',
      provider: 'claude',
      modelId: 'qwen3.5-plus',
    }
    const glmModel: UnifiedModel = {
      name: 'glm-5',
      type: 'public',
      displayName: '公网:GLM-5',
      provider: 'claude',
      modelId: 'glm-5',
    }
    const minimaxModel: UnifiedModel = {
      name: 'minimax-m1',
      type: 'public',
      displayName: '公网:MiniMax-M1',
      provider: 'claude',
      modelId: 'minimax-m1',
    }
    const claudeModel: UnifiedModel = {
      name: 'Claude-Opus4.6',
      type: 'public',
      displayName: '海外:Claude-Opus4.6',
      provider: 'claude',
      modelId: 'claude-opus-4-6',
    }

    expect(inferModelFamily(deepseekModel)).toBe('deepseek')
    expect(inferModelFamily(qwenModel)).toBe('qwen')
    expect(inferModelFamily(glmModel)).toBe('glm')
    expect(inferModelFamily(minimaxModel)).toBe('minimax')
    expect(inferModelFamily(claudeModel)).toBe('claude')

    const groups = groupModelsByFamily([
      deepseekModel,
      qwenModel,
      glmModel,
      minimaxModel,
      claudeModel,
    ])
    const claudeGroup = groups.find(group => group.config.id === 'claude')
    const glmGroup = groups.find(group => group.config.id === 'glm')
    const deepseekGroup = groups.find(group => group.config.id === 'deepseek')
    const qwenGroup = groups.find(group => group.config.id === 'qwen')
    const minimaxGroup = groups.find(group => group.config.id === 'minimax')

    expect(claudeGroup?.models.map(model => model.name)).toEqual(['Claude-Opus4.6'])
    expect(glmGroup?.config.label).toBe('GLM')
    expect(glmGroup?.models.map(model => model.name)).toEqual(['glm-5'])
    expect(deepseekGroup?.config.label).toBe('DeepSeek')
    expect(deepseekGroup?.models.map(model => model.name)).toEqual(['ali-deepseek-v4-flash(公网)'])
    expect(qwenGroup?.config.label).toBe('Qwen')
    expect(qwenGroup?.models.map(model => model.name)).toEqual(['ali-qwen3.5-plus(公网)'])
    expect(minimaxGroup?.config.label).toBe('MiniMax')
    expect(minimaxGroup?.models.map(model => model.name)).toEqual(['minimax-m1'])
    expect(isSupportedModelFamily(deepseekModel)).toBe(true)
  })

  test.each(['gpt'])(
    'uses catalog reasoning instead of the generic %s control for cloud DeepSeek',
    family => {
      const model: UnifiedModel = {
        name: 'deepseek-flash-responses(公网)',
        type: 'public',
        modelId: 'deepseek-flash',
        config: {
          protocol: 'openai-responses',
          ui: { family, controls: ['speed'] },
        },
      }
      const controls = getControlsForModel(model)
      const reasoning = controls.find(control => control.id === 'reasoning')

      expect(controls.map(control => control.id)).toEqual([
        'reasoning',
        'collaborationMode',
        'speed',
      ])
      expect(reasoning?.options.map(option => option.value)).toEqual(['low', 'high', 'max'])
      expect(reasoning?.defaultValue).toBe('high')
      expect(normalizeModelOptions(model, { reasoning: 'max' }).reasoning).toBe('max')
      expect(normalizeModelOptions(model, { reasoning: 'medium' }).reasoning).toBe('high')
      expect(inferModelFamily(model)).toBe(family)
    }
  )

  test.each([
    { provider: 'local', modelId: 'deepseek-flash' },
    { provider: 'openai', modelId: 'unknown-model' },
    { provider: 'openai', modelId: 'kimi-for-coding' },
  ])('preserves generic controls without usable cloud catalog reasoning: %o', identity => {
    const model: UnifiedModel = {
      ...identity,
      name: 'generic-interface',
      type: 'runtime',
      config: {
        protocol: 'openai-responses',
        ui: { family: 'model-interface' },
      },
    }
    const reasoning = getControlsForModel(model).find(control => control.id === 'reasoning')

    expect(reasoning?.options.map(option => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(reasoning?.defaultValue).toBe('high')
  })

  test('uses runtime family instead of Kimi display identity for compatibility', () => {
    const claudeCompatibleKimi: UnifiedModel = {
      name: 'kimi-k2.5(内网)',
      type: 'public',
      displayName: '内网:Kimi-K2.5',
      modelId: 'kimi-k2.5',
      runtime: { family: 'claude.claude' },
    }
    const gptModel: UnifiedModel = {
      name: 'wecode-gpt-5.5(海外)',
      type: 'public',
      displayName: '海外:GPT5.5',
      modelId: 'gpt-5.5',
      runtime: { family: 'openai.openai-responses' },
    }
    const unknownKimi: UnifiedModel = {
      name: 'kimi-without-protocol',
      type: 'public',
      displayName: 'Kimi Without Protocol',
    }

    expect(inferModelFamily(claudeCompatibleKimi)).toBe('kimi')
    expect(getModelCompatibilityFamily(claudeCompatibleKimi)).toBe('claude.claude')
    expect(areModelsProtocolCompatible(claudeCompatibleKimi, gptModel)).toBe(false)
    expect(areModelsProtocolCompatible(gptModel, unknownKimi)).toBe(false)
  })

  test('enables model-scoped speed control from object-shaped ui controls', () => {
    const model: UnifiedModel = {
      name: 'overseas-gpt-5.5',
      type: 'user',
      displayName: '海外:gpt-5.5',
      config: {
        ui: {
          family: 'gpt',
          controls: {
            speed: true,
          },
        },
      },
    }

    expect(getControlsForModel(model).map(control => control.id)).toEqual([
      'reasoning',
      'collaborationMode',
      'speed',
    ])
  })

  test('keeps same-id API and Codex Auth models as distinct selections', () => {
    const official: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      modelId: 'gpt-5.6-sol',
      config: {
        weworkModelKind: 'codex-official',
        ui: { family: 'codex-official' },
      },
    }
    const api: UnifiedModel = {
      name: 'local-model:api-sol',
      type: 'runtime',
      modelId: 'gpt-5.6-sol',
      config: {
        weworkModelKind: 'model-interface',
        ui: { family: 'model-interface', reasoningEfforts: ['low', 'high'] },
      },
    }

    expect(isCodexOfficialModel(official)).toBe(true)
    expect(isCodexOfficialModel(api)).toBe(false)
    expect(isModelInterfaceModel(api)).toBe(true)
    expect(isSameModelSelection(official, api)).toBe(false)
    expect(isSameModelSelection(api, { ...api })).toBe(true)
  })
})
