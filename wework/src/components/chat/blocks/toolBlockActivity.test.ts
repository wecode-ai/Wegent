// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { summarizeToolBlocks } from './toolBlockActivity'

describe('toolBlockActivity', () => {
  test('classifies namespaced tool aliases without requiring exact prefixes', () => {
    expect(
      summarizeToolBlocks([
        {
          id: 'read-file-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'mcp__filesystem__read_file',
          toolInput: { path: 'README.md' },
          status: 'done',
          createdAt: 1770000000000,
        },
        {
          id: 'edit-file-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'custom.editor.edit_file',
          toolInput: { path: 'README.md' },
          status: 'done',
          createdAt: 1770000000001,
        },
      ])
    ).toBe('已读取 1 个文件 已编辑 1 个文件')
  })
})
