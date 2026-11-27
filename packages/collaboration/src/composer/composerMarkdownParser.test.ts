import { expect, it } from 'vitest'
import { createComposerDocument } from './composerProseMirrorModel'
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
  ['First<br>Second', 'First'],
  ['First<br />Second', 'First'],
  ['`First<br>Second`', 'First<br>Second'],
])('derives a title from the first semantic Markdown line: %s', (content, title) => {
  expect(composerMarkdownText(content, { firstLine: true })).toBe(title)
})

it('keeps complete plain-text context when flattening Markdown for a summary', () => {
  expect(composerMarkdownText('# Review\n\nCheck **filters** and `C:\\logs\\executor`.')).toBe(
    'Review Check filters and C:\\logs\\executor.'
  )
})

it('preserves HTML hard breaks as summary whitespace while keeping code literal', () => {
  expect(composerMarkdownText('First<br>Second and `literal<br>code`')).toBe(
    'First Second and literal<br>code'
  )
})

it.each([
  ['- ', 'bullet_list'],
  ['1. ', 'ordered_list'],
])('keeps an empty Markdown list item editable: %s', (content, listType) => {
  const doc = createComposerDocument(content)
  const list = doc.firstChild
  const item = list?.firstChild

  expect(list?.type.name).toBe(listType)
  expect(item?.type.name).toBe('list_item')
  expect(item?.firstChild?.type.name).toBe('paragraph')
  expect(item?.firstChild?.content.size).toBe(0)
})

it('prepends an empty paragraph when a list item starts with a nested list', () => {
  const doc = createComposerDocument('- \n  - child')
  const item = doc.firstChild?.firstChild

  expect(item?.childCount).toBe(2)
  expect(item?.child(0).type.name).toBe('paragraph')
  expect(item?.child(1).type.name).toBe('bullet_list')
})
