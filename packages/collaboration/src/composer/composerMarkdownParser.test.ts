import { expect, it } from 'vitest'
import { composerMarkdownText } from './composerMarkdownParser'

it.each([
  ['# 客户反馈处理流程\n\n本周需要整理反馈。\n\n## 验收结果\n- 保留草稿', '客户反馈处理流程'],
  [
    'Review keyboard navigation\n\nCheck directional navigation, filters, and empty-state recovery.',
    'Review keyboard navigation',
  ],
  ['Investigate timeout\nOnly Windows clients are affected.', 'Investigate timeout'],
  ['```text\nC:\\logs\\executor\n```', 'C:\\logs\\executor'],
  ['- **Review** [feedback](https://example.com)\n- Follow up', 'Review feedback'],
])('derives a title from the first semantic Markdown line: %s', (content, title) => {
  expect(composerMarkdownText(content, { firstLine: true })).toBe(title)
})

it('keeps complete plain-text context when flattening Markdown for a summary', () => {
  expect(composerMarkdownText('# Review\n\nCheck **filters** and `C:\\logs\\executor`.')).toBe(
    'Review Check filters and C:\\logs\\executor.'
  )
})
