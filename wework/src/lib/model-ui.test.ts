import { describe, expect, test } from 'vitest'
import {
  areModelsProtocolCompatible,
  getModelCompatibilityFamily,
  getSelectedModelDisplayLabel,
  getControlsForModel,
  groupModelsByFamily,
  inferModelFamily,
  isSupportedModelFamily,
  normalizeModelOptions,
} from './model-ui'
import type { UnifiedModel } from '@/types/api'

describe('model-ui', () => {
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

  test('sorts model options by intranet first and newer versions first', () => {
    const models: UnifiedModel[] = [
      {
        name: 'glm-public-5',
        type: 'public',
        displayName: '公网:GLM-5',
        modelId: 'glm-5',
      },
      {
        name: 'glm-public-5.1',
        type: 'public',
        displayName: '公网:GLM-5.1',
        modelId: 'glm-5.1',
      },
      {
        name: 'glm-public-5v',
        type: 'public',
        displayName: '公网:GLM-5v',
        modelId: 'glm-5v',
      },
      {
        name: 'glm-public-4.7',
        type: 'public',
        displayName: '公网:GLM4.7',
        modelId: 'glm-4.7',
      },
      {
        name: 'glm-intranet-5',
        type: 'user',
        displayName: '内网:GLM5',
        modelId: 'glm-5',
      },
      {
        name: 'glm-intranet-5.1',
        type: 'user',
        displayName: '内网:GLM5.1',
        modelId: 'glm-5.1',
      },
    ]

    const glmGroup = groupModelsByFamily(models).find(group => group.config.id === 'glm')

    expect(glmGroup?.models.map(model => model.displayName)).toEqual([
      '内网:GLM5.1',
      '内网:GLM5',
      '公网:GLM-5.1',
      '公网:GLM-5',
      '公网:GLM-5v',
      '公网:GLM4.7',
    ])
  })

  test('separates Codex official, provider, and interface models from GPT', () => {
    const codexModel: UnifiedModel = {
      name: 'gpt-5.5',
      type: 'runtime',
      displayName: 'gpt-5.5',
      config: {
        ui: { family: 'codex-official', modelLabel: 'gpt-5.5' },
      },
    }
    const providerModel: UnifiedModel = {
      name: 'Doubao-Seed-2.0-pro-260215',
      type: 'runtime',
      displayName: 'Doubao-Seed-2.0-pro-260215',
      config: {
        ui: {
          family: 'codex-provider:wecode-openai',
          familyLabel: 'wecode openai',
          modelLabel: 'Doubao-Seed-2.0-pro-260215',
        },
      },
    }
    const interfaceModel: UnifiedModel = {
      name: 'local-model:ollama',
      type: 'runtime',
      displayName: 'Ollama GPT',
      config: {
        ui: { family: 'model-interface', modelLabel: 'Ollama GPT' },
      },
    }
    const gptModel: UnifiedModel = {
      name: 'gpt-5',
      type: 'public',
      displayName: 'GPT-5',
    }

    expect(inferModelFamily(codexModel)).toBe('codex-official')
    expect(inferModelFamily(providerModel)).toBe('codex-provider:wecode-openai')
    expect(inferModelFamily(interfaceModel)).toBe('model-interface')
    expect(inferModelFamily(gptModel)).toBe('gpt')

    const groups = groupModelsByFamily([gptModel, providerModel, interfaceModel, codexModel])
    expect(groups.map(group => group.config.id)).toEqual([
      'codex-official',
      'codex-provider:wecode-openai',
      'model-interface',
      'gpt',
    ])
    expect(groups.map(group => group.config.label)).toEqual([
      '我的CodeX',
      'wecode openai',
      '自定义模型',
      'GPT',
    ])
  })

  test('uses custom group labels for local interface model families', () => {
    const localModel: UnifiedModel = {
      name: 'local-model:ollama',
      type: 'runtime',
      displayName: 'Ollama GPT',
      config: {
        ui: {
          family: 'model-interface:%E6%9C%AC%E5%9C%B0%E6%8E%A8%E7%90%86',
          familyLabel: '本地推理',
          modelLabel: 'Ollama GPT',
          controls: ['speed'],
        },
      },
    }

    const group = groupModelsByFamily([localModel])[0]

    expect(group.config.id).toBe('model-interface:%e6%9c%ac%e5%9c%b0%e6%8e%a8%e7%90%86')
    expect(group.config.label).toBe('本地推理')
    expect(getControlsForModel(localModel).map(control => control.id)).toEqual([
      'reasoning',
      'collaborationMode',
      'speed',
    ])
  })

  test('adds catalog control to any model that supports the Responses API', () => {
    const deepseekResponsesModel: UnifiedModel = {
      name: 'huoshan-deepseek-v4-pro',
      type: 'public',
      displayName: 'DeepSeek V4 Pro',
      modelId: 'huoshan-deepseek-v4-pro',
      config: {
        protocol: 'openai-responses',
      },
    }
    const deepseekNonResponsesModel: UnifiedModel = {
      name: 'huoshan-deepseek-v4',
      type: 'public',
      displayName: 'DeepSeek V4',
      modelId: 'huoshan-deepseek-v4',
    }

    expect(inferModelFamily(deepseekResponsesModel)).toBe('deepseek')
    expect(getControlsForModel(deepseekNonResponsesModel).map(control => control.id)).not.toContain(
      'catalogModelId'
    )
  })

  test('detects runtime family compatibility without changing display families', () => {
    const claudeCompatibleDeepseek: UnifiedModel = {
      name: 'ali-deepseek-v4-flash',
      type: 'public',
      displayName: '公网:DeepSeek V4 Flash',
      modelId: 'deepseek-v4-flash',
      runtime: { family: 'claude.claude' },
    }
    const claudeModel: UnifiedModel = {
      name: 'claude-sonnet-4-5',
      type: 'public',
      modelId: 'claude-sonnet-4-5',
      runtime: { family: 'claude.claude' },
    }
    const gptModel: UnifiedModel = {
      name: 'gpt-5.5-medium',
      type: 'user',
      runtime: { family: 'openai.openai-responses' },
    }
    const chatGptModel: UnifiedModel = {
      name: 'gpt-5-2025-08-07',
      type: 'public',
      provider: 'openai',
      runtime: { family: 'openai', provider: 'openai' },
    }
    const geminiModel: UnifiedModel = {
      name: 'gemini-2.5-pro',
      type: 'public',
      runtime: { family: 'gemini.gemini' },
    }

    expect(inferModelFamily(claudeCompatibleDeepseek)).toBe('deepseek')
    expect(getModelCompatibilityFamily(claudeCompatibleDeepseek)).toBe('claude.claude')
    expect(areModelsProtocolCompatible(claudeCompatibleDeepseek, claudeModel)).toBe(true)
    expect(areModelsProtocolCompatible(claudeCompatibleDeepseek, gptModel)).toBe(false)
    expect(areModelsProtocolCompatible(gptModel, chatGptModel)).toBe(true)
    expect(areModelsProtocolCompatible(gptModel, geminiModel)).toBe(false)
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

  test('uses xhigh for extra-high reasoning while accepting stored extra_high values', () => {
    const model: UnifiedModel = {
      name: 'gpt-5.5',
      type: 'runtime',
      displayName: 'gpt-5.5',
      config: {
        ui: { family: 'codex-official', modelLabel: 'gpt-5.5' },
      },
    }

    const reasoningControl = getControlsForModel(model).find(control => control.id === 'reasoning')

    expect(reasoningControl?.options.map(option => option.value)).toContain('xhigh')
    expect(reasoningControl?.options.map(option => option.value)).not.toContain('extra_high')
    expect(normalizeModelOptions(model, { reasoning: 'extra_high' })).toEqual({
      reasoning: 'xhigh',
    })
    expect(getSelectedModelDisplayLabel(model, { reasoning: 'extra_high' })).toBe(
      'gpt-5.5 Extra High'
    )
  })

  test('uses the model-advertised reasoning order, default, max, and ultra values', () => {
    const model: UnifiedModel = {
      name: 'gpt-5.6-sol',
      type: 'runtime',
      displayName: 'GPT 5.6 Sol',
      config: {
        ui: {
          family: 'codex-official',
          modelLabel: 'GPT 5.6 Sol',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultReasoningEffort: 'low',
        },
      },
    }

    const reasoningControl = getControlsForModel(model).find(control => control.id === 'reasoning')

    expect(reasoningControl).toMatchObject({
      defaultValue: 'low',
      options: [
        { value: 'low' },
        { value: 'medium' },
        { value: 'high' },
        { value: 'xhigh' },
        { value: 'max' },
        { value: 'ultra' },
      ],
    })
    expect(normalizeModelOptions(model, { reasoning: 'ultra' })).toEqual({
      reasoning: 'ultra',
    })
  })

  test('falls back to the advertised default when a stored effort is unsupported', () => {
    const model: UnifiedModel = {
      name: 'gpt-5.6-luna',
      type: 'runtime',
      displayName: 'GPT 5.6 Luna',
      config: {
        ui: {
          family: 'codex-official',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultReasoningEffort: 'medium',
        },
      },
    }

    expect(normalizeModelOptions(model, { reasoning: 'ultra' })).toEqual({
      reasoning: 'medium',
    })
  })
})
