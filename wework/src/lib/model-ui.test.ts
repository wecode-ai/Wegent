import { describe, expect, test } from 'vitest'
import {
  areModelsProtocolCompatible,
  getModelCompatibilityFamily,
  groupModelsByFamily,
  inferModelFamily,
  isSupportedModelFamily,
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
    expect(deepseekGroup?.models.map(model => model.name)).toEqual([
      'ali-deepseek-v4-flash(公网)',
    ])
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
    const geminiModel: UnifiedModel = {
      name: 'gemini-2.5-pro',
      type: 'public',
      runtime: { family: 'gemini.gemini' },
    }

    expect(inferModelFamily(claudeCompatibleDeepseek)).toBe('deepseek')
    expect(getModelCompatibilityFamily(claudeCompatibleDeepseek)).toBe('claude.claude')
    expect(areModelsProtocolCompatible(claudeCompatibleDeepseek, claudeModel)).toBe(true)
    expect(areModelsProtocolCompatible(claudeCompatibleDeepseek, gptModel)).toBe(false)
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
})
