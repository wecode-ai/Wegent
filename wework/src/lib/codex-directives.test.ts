import { describe, expect, test } from 'vitest'
import { splitCodexInlineVisualizations, stripCodexUiDirectives } from './codex-directives'

describe('stripCodexUiDirectives', () => {
  test('strips Codex UI directive lines outside code fences', () => {
    expect(
      stripCodexUiDirectives(
        [
          '当前分支已经准备好。',
          '::git-stage{cwd="/workspace/project"} ::git-commit{cwd="/workspace/project"}',
          '可以继续提交。',
        ].join('\n')
      )
    ).toBe('当前分支已经准备好。\n\n可以继续提交。')
  })

  test('preserves directive-like text inside code fences', () => {
    const content = [
      '```text',
      '::git-stage{cwd="/workspace/project"}',
      '::git-commit{cwd="/workspace/project"}',
      '```',
    ].join('\n')

    expect(stripCodexUiDirectives(content)).toBe(content)
  })

  test('keeps mixed directive and non-directive content readable', () => {
    expect(
      stripCodexUiDirectives(
        [
          '已完成 rebase。',
          '::git-push{cwd="/workspace/project" branch="codex/example"}',
          'PR 已更新。',
          '普通的 ::git-push 文本不会被处理。',
        ].join('\n')
      )
    ).toBe(['已完成 rebase。', '', 'PR 已更新。', '普通的 ::git-push 文本不会被处理。'].join('\n'))
  })

  test('collapses blank lines introduced by multiple stripped directives', () => {
    expect(
      stripCodexUiDirectives(
        [
          '第一段',
          '',
          '::git-stage{cwd="/workspace/project"}',
          '',
          '::git-commit{cwd="/workspace/project"}',
          '',
          '第二段',
        ].join('\n')
      )
    ).toBe('第一段\n\n第二段')
  })

  test('keeps valid inline visualization directives for the message renderer', () => {
    const content = ['已生成图表。', '', '::codex-inline-vis{file="reports/trend.html"}'].join('\n')

    expect(stripCodexUiDirectives(content)).toBe(content)
    expect(splitCodexInlineVisualizations(content)).toEqual([
      { kind: 'markdown', content: '已生成图表。\n' },
      { kind: 'visualization', file: 'reports/trend.html' },
    ])
  })

  test('preserves malformed, unsafe, and code-fenced visualization directives as markdown', () => {
    const content = [
      '::codex-inline-vis{file="../private.html"}',
      '```text',
      '::codex-inline-vis{file="trend.html"}',
      '```',
      '::codex-inline-vis{file="trend.txt"}',
    ].join('\n')

    expect(splitCodexInlineVisualizations(content)).toEqual([{ kind: 'markdown', content }])
  })
})
