import type { Nodes } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, test } from 'vitest'
import { preprocessCjkEmphasis } from './preprocessCjkEmphasis'

function emphasis(source: string) {
  const types: string[] = []
  const visit = (node: Nodes) => {
    if (node.type === 'strong' || node.type === 'emphasis') types.push(node.type)
    if ('children' in node) node.children.forEach(visit)
  }
  visit(unified().use(remarkParse).parse(source))
  return types
}

describe('CJK display emphasis normalization', () => {
  test.each(['。', '！', '？', '）', '】', '”'])(
    'renders closing %s followed by Chinese text',
    mark => {
      const source = `**今晚没有会议${mark}**明天再准备。`
      expect(emphasis(source)).toEqual([])
      expect(emphasis(preprocessCjkEmphasis(source))).toEqual(['strong'])
      expect(preprocessCjkEmphasis(source).replaceAll('\u200B', '')).toBe(source)
    }
  )

  test('preserves italic support and is idempotent', () => {
    const normalized = preprocessCjkEmphasis('*待确认。*请先查看。')
    expect(emphasis(normalized)).toEqual(['emphasis'])
    expect(preprocessCjkEmphasis(normalized)).toBe(normalized)
  })

  test.each([
    '`**示例。**不要改`',
    '``包含 ` 和 **示例。** 的代码``',
    '`多行\n**示例。**不要改`',
    '```text\n**示例。**不要改\n```',
    '~~~text\n**示例。**不要改\n~~~',
    '```text\n**尚未闭合。**不要改',
    '    **缩进代码。**不要改',
    '> ```text\n> **引用中的代码。**不要改\n> ```',
    '<pre>**HTML 示例。**不要改</pre>',
  ])('preserves code source byte for byte: %s', source => {
    expect(preprocessCjkEmphasis(source)).toBe(source)
  })

  test('normalizes adjacent prose while preserving fenced and inline examples', () => {
    const code = '`**示例。**不要改`\n\n~~~text\n**示例。**不要改\n~~~'
    const source = `**今晚没有会议。**明天再准备。\n\n${code}\n\n**还有一项。**请确认。`
    const result = preprocessCjkEmphasis(source)
    expect(emphasis(result)).toEqual(['strong', 'strong'])
    expect(result).toContain(code)
  })
})
