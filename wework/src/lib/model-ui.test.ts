import { describe, expect, test } from 'vitest'
import {
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
})
