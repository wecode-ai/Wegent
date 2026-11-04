// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { splitCodexInlineVisualizations, stripCodexUiDirectives } from './codex-directives'

describe('stripCodexUiDirectives', () => {
  test('keeps valid inline visualization directives for the message renderer', () => {
    const content = ['已生成图表。', '', '::codex-inline-vis{file="reports/trend.html"}'].join('\n')

    expect(stripCodexUiDirectives(content)).toBe(content)
    expect(splitCodexInlineVisualizations(content)).toEqual([
      { kind: 'markdown', content: '已生成图表。\n' },
      { kind: 'visualization', file: 'reports/trend.html' },
    ])
  })

  test('parses visualize references from any absolute HTML path', () => {
    const content = [
      'visualize{"path":"/Users/me/project/output/task-board.html","mode":"wide","title":"Task board"}',
      'visualize{"path":"/tmp/private.html"}',
    ].join('\n')

    expect(splitCodexInlineVisualizations(content)).toEqual([
      {
        kind: 'visualization',
        file: '/Users/me/project/output/task-board.html',
        mode: 'wide',
        title: 'Task board',
      },
      {
        kind: 'visualization',
        file: '/tmp/private.html',
      },
    ])
  })

  test('preserves malformed, unsafe, and code-fenced visualization directives as markdown', () => {
    const content = [
      '::codex-inline-vis{file="../private.html"}',
      'visualize{"path":"relative/visualizations/trend.html"}',
      'visualize{"path":"/Users/me/project/../private.html"}',
      '```text',
      '::codex-inline-vis{file="trend.html"}',
      'visualize{"path":"/tmp/visualizations/trend.html"}',
      '```',
      '::codex-inline-vis{file="trend.txt"}',
    ].join('\n')

    expect(splitCodexInlineVisualizations(content)).toEqual([{ kind: 'markdown', content }])
  })
})
