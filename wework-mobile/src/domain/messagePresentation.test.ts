import { describe, expect, it } from 'vitest'

import type { ChatProcessingBlock, ChatToolBlock } from '@/types/runtime'
import {
  buildMessageDisplayRows,
  buildThinkingPreview,
  getToolActivityKind,
} from './messagePresentation'

function tool(
  id: string,
  toolName: string,
  status: ChatToolBlock['status'] = 'done',
  toolInput?: Record<string, unknown>
): ChatToolBlock {
  return {
    id,
    subtaskId: 'turn-1',
    type: 'tool',
    toolName,
    toolInput,
    status,
    createdAt: 1,
  }
}

describe('messagePresentation', () => {
  it('hides completed thinking and keeps narrative/tool order', () => {
    const blocks: ChatProcessingBlock[] = [
      {
        id: 'thinking-1',
        subtaskId: 'turn-1',
        type: 'thinking',
        content: '内部思考',
        status: 'done',
        createdAt: 1,
      },
      {
        id: 'text-1',
        subtaskId: 'turn-1',
        type: 'text',
        content: '第一段',
        status: 'done',
        createdAt: 2,
      },
      tool('web-1', 'web_search'),
      {
        id: 'text-2',
        subtaskId: 'turn-1',
        type: 'text',
        content: '最终内容',
        status: 'done',
        createdAt: 4,
      },
    ]

    expect(buildMessageDisplayRows(blocks, '最终内容')).toMatchObject([
      { type: 'narrative', block: { id: 'text-1' } },
      { type: 'tool-group', label: '已搜索网页 1 次' },
    ])
  })

  it('groups consecutive completed tools by Wework activity kind', () => {
    const rows = buildMessageDisplayRows(
      [tool('web-1', 'web_search'), tool('web-2', 'web_search'), tool('read-1', 'read_file')],
      ''
    )

    expect(rows).toMatchObject([
      { type: 'tool-group', kind: 'web', label: '已搜索网页 2 次' },
      { type: 'tool-group', kind: 'file', label: '已读取 1 个文件' },
    ])
  })

  it('classifies command activity from the normalized command input', () => {
    expect(getToolActivityKind(tool('search-1', 'bash', 'done', { command: 'rg TODO src' }))).toBe(
      'search'
    )
    expect(
      getToolActivityKind(tool('read-1', 'bash', 'done', { command: 'sed -n 1,20p a.ts' }))
    ).toBe('file')
  })

  it('reduces active thinking to the latest plain-text sentence', () => {
    expect(buildThinkingPreview('先分析。\n\n**现在检查** `App.tsx`！')).toBe('现在检查 App.tsx')
  })
})
