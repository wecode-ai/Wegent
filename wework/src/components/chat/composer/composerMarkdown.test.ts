import { describe, expect, test } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { createComposerDocument, serializeComposerDocument } from './composerProseMirrorModel'
import {
  positionFromSerializedOffset,
  serializedOffsetFromPosition,
} from './composerMarkdownSerializer'

const markdownTable =
  '| 项目 | 说明 | 示例 |\n| :--- | --- | ---: |\n| 中文 | **重点** | `a\\|b` |\n| 空单元格 | | |'

describe('composer Markdown', () => {
  test.each(['哈哈哈哈', 'more text', '科技汉江红果发就开始\n科技海峰卡说红果看'])(
    'keeps appended text outside an existing URL: %s',
    suffix => {
      const url = 'https://example.com/1192966660/Riodm8zUo'
      const state = EditorState.create({ doc: createComposerDocument(url) })
      const doc = state.apply(state.tr.insertText(suffix, url.length + 1)).doc
      expect(doc.firstChild?.lastChild?.marks).toEqual([])
      const value = serializeComposerDocument(doc)
      expect(value).toBe(`[${url}](${url})${suffix}`)
      const restored = createComposerDocument(value)
      expect(serializeComposerDocument(restored)).toBe(value)
      expect(restored.firstChild?.firstChild?.marks[0].attrs.href).toBe(url)
    }
  )

  test('keeps an entire pasted Unicode URL intact', () => {
    const url = 'https://example.com/中文路径?查询=中文'
    const doc = createComposerDocument(url)
    expect(doc.firstChild?.firstChild?.marks[0].attrs.href).toBe(url)
    expect(serializeComposerDocument(doc)).toBe(url)
  })

  test('preserves link boundaries when prepending text or editing its label', () => {
    const url = 'https://example.com/page'
    const state = EditorState.create({ doc: createComposerDocument(url) })
    expect(serializeComposerDocument(state.apply(state.tr.insertText('查看', 1)).doc)).toBe(
      `查看[${url}](${url})`
    )
    const position = url.indexOf('page') + 2
    const edited = state.apply(state.tr.insertText('new', position, position + 2)).doc
    expect(serializeComposerDocument(edited)).toBe(`[https://example.com/pnewe](${url})`)
  })

  test.each([
    '普通中文输入 English 123',
    '第一行\n\n第三行\n',
    '  前后空格  ',
    '{\n  "event_type": "http_exchange",\n  "id": "e9972aac"\n}',
    '访问 http://example.com/path?q=1&name=test#section',
    '访问 https://example.com/path?q=1&name=test#section',
    'www.example.com',
  ])('preserves ordinary text and bare URLs verbatim: %s', value => {
    expect(serializeComposerDocument(createComposerDocument(value))).toBe(value)
  })

  test('keeps bare URLs literal alongside Markdown formatting', () => {
    const value = '**说明** http://example.com/file_name?q=hello_world&n=1#part_1'
    expect(serializeComposerDocument(createComposerDocument(value))).toBe(value)
  })

  test('keeps inline code inside its link when sending or restoring a draft', () => {
    const value = '[`example`](https://example.com)'
    const doc = createComposerDocument(value)
    expect(serializeComposerDocument(doc)).toBe(value)
    expect(doc.firstChild?.firstChild?.marks.map(mark => mark.type.name)).toEqual(['link', 'code'])
  })

  test('preserves an ordered list starting at zero', () => {
    const value = '0. First\n1. Second'
    const doc = createComposerDocument(value)
    expect(doc.firstChild?.attrs.start).toBe(0)
    expect(serializeComposerDocument(doc)).toBe(value)
  })

  test('parses editable table cells and preserves alignment, marks and empty cells', () => {
    const doc = createComposerDocument(markdownTable)
    const table = doc.firstChild!
    expect(table.type.name).toBe('table')
    expect(table.childCount).toBe(3)
    expect(table.child(0).child(0).attrs.align).toBe('left')
    expect(table.child(1).child(1).firstChild?.firstChild?.marks[0].type.name).toBe('strong')
    expect(table.child(1).child(2).textContent).toBe('a|b')
    expect(table.child(2).child(2).textContent).toBe('')
    expect(serializeComposerDocument(doc)).toBe(
      markdownTable.replace('| 空单元格 | | |', '| 空单元格 |  |  |')
    )
  })

  test.each([
    markdownTable,
    '`` `code` ``',
    '**`bold code`**',
    '[**bold** and `code`](https://example.com)',
    '[文档](https://example.com/doc)',
    '[$Quality](quality://report) ',
    '**bold** next  ',
    '\\*literal\\*',
    '前文\n\n' + markdownTable + '\n\n后文',
    '# 标题\n\n**粗体**、*斜体*、~~删除~~ 和 `code`',
    '3. 第一项\n4. 第二项\n\n   - 嵌套',
    '> 引用\n>\n> 第二段',
    '```ts\nconst x = `value`\n```',
    '- [x] 完成\n- [ ] 待办',
    '| A | B |\n| --- | --- |\n| 一<br>二 | |',
    '| A | B |\n| --- | --- |\n| [$gmail](/tmp/gmail/SKILL.md) | [PR](https://github.com/a/b/pull/1) |',
  ])('keeps Markdown stable across draft restoration: %s', value => {
    const first = createComposerDocument(value)
    const serialized = serializeComposerDocument(first)
    expect(serializeComposerDocument(createComposerDocument(serialized))).toBe(serialized)
  })

  test('maps every visible table text position to its Markdown offset and back', () => {
    const doc = createComposerDocument(markdownTable)
    doc.descendants((node, start) => {
      if (!node.isText) return true
      for (let i = 0; i <= node.nodeSize; i++) {
        const offset = serializedOffsetFromPosition(doc, start + i)
        expect(positionFromSerializedOffset(doc, offset)).toBe(start + i)
      }
      return false
    })
  })

  test('keeps raw HTML inert and code content literal', () => {
    const value = '```html\n<script>alert(1)</script>\n**literal**\n```'
    const doc = createComposerDocument(value)
    expect(doc.firstChild?.type.name).toBe('code_block')
    expect(doc.firstChild?.textContent).toBe('<script>alert(1)</script>\n**literal**')
    expect(serializeComposerDocument(doc)).toBe(value)
  })
})
