import { describe, expect, test } from 'vitest'
import type { TFunction } from 'i18next'
import { buildPluginGuidePresentation, inferPluginGuideKind } from './plugin-guide-presentation'

const t = ((
  key: string,
  fallbackOrOptions?: string | { defaultValue?: string; [key: string]: unknown }
) => {
  if (typeof fallbackOrOptions === 'string') return fallbackOrOptions
  const fallback = fallbackOrOptions?.defaultValue ?? key
  return Object.entries(fallbackOrOptions ?? {}).reduce((value, [name, replacement]) => {
    if (name === 'defaultValue') return value
    return value.replaceAll(`{{${name}}}`, String(replacement))
  }, fallback)
}) as TFunction<'common'>

describe('buildPluginGuidePresentation', () => {
  test('does not treat checkout as a code check', () => {
    expect(inferPluginGuideKind('Test my checkout flow on localhost')).toBe('general')
  })

  test('uses a concrete Browser checkout guide instead of code review copy', () => {
    const presentation = buildPluginGuidePresentation({
      kind: inferPluginGuideKind('Test my checkout flow on localhost'),
      prompt: 'Test my checkout flow on localhost',
      title: 'Test my checkout flow on localhost',
      pluginName: 'Browser',
      pluginDescription: 'Control the in-app browser and interact with web pages.',
      capabilities: [
        {
          name: 'control-in-app-browser',
          description: 'Navigate, click, type, and capture screenshots.',
          type: 'skill',
        },
      ],
      t,
    })

    expect(presentation.displayTitle).toBe('测试本地结账流程')
    expect(presentation.includedItems).toEqual([
      '打开本地网站，按用户顺序走完结账流程',
      '检查金额、表单、跳转和错误提示',
      '记录失败步骤和页面现象，提交订单前先停下',
    ])
    expect(presentation.confirmation.question).toBe('测试到哪一步？')
    expect(presentation.confirmation.defaultOptionId).toBe('before-submit')
  })

  test('generates a Sites draft from the selected sudoku scenario and plugin capabilities', () => {
    const presentation = buildPluginGuidePresentation({
      kind: 'create',
      prompt: 'Create a daily sudoku game with a leaderboard',
      title: 'Create a daily sudoku game with a leaderboard',
      pluginName: 'Sites',
      pluginDescription: 'Build websites, apps, games, and internal tools with Sites.',
      capabilities: [
        {
          name: 'sites-building',
          description: 'Build a complete website from the selected task.',
          type: 'skill',
        },
        {
          name: 'sites-hosting',
          description: 'Preview and publish the generated site.',
          type: 'skill',
        },
      ],
      t,
    })

    expect(presentation.capabilityNames).toEqual(['sites-building', 'sites-hosting'])
    expect(presentation.includedItems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('9×9'),
        expect.stringContaining('排行榜'),
        expect.stringContaining('移动端'),
      ])
    )
    expect(presentation.generatedPrompt).toBe('Create a daily sudoku game with a leaderboard')
    expect(presentation.confirmation.question).toBe('排行榜如何展示玩家？')
    expect(presentation.confirmation.defaultOptionId).toBe('nickname')
    expect(presentation.confirmation.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'anonymous', label: '匿名排行' }),
        expect.objectContaining({ id: 'none', label: '暂不启用' }),
      ])
    )
  })

  test('turns code review depth into a concrete review focus', () => {
    const presentation = buildPluginGuidePresentation({
      kind: 'review',
      prompt: 'Review my current working-tree changes.',
      title: 'Review my current working-tree changes.',
      pluginName: 'Code Review',
      pluginDescription: 'Find actionable defects in code changes.',
      capabilities: [],
      t,
    })

    expect(presentation.confirmation.question).toBe('这次最关注什么？')
    expect(presentation.confirmation.defaultOptionId).toBe('test-quality')
    expect(presentation.confirmation.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'merge-risk', label: '合并风险' }),
        expect.objectContaining({ id: 'test-quality', label: '测试质量' }),
        expect.objectContaining({ id: 'architecture', label: '架构影响' }),
      ])
    )
  })
})
