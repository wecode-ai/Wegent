import { describe, expect, test } from 'vitest'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import { buildProcessingDisplayRows, summarizeToolBlocks } from './toolBlockActivity'

function tool(
  id: string,
  command: string,
  status: ToolBlock['status'] = 'done'
): ToolBlock {
  return {
    id,
    subtaskId: 1,
    type: 'tool',
    toolName: 'bash',
    toolInput: { command },
    status,
    createdAt: 1770000000000,
  }
}

describe('toolBlockActivity', () => {
  test('summarizes completed file, search, command, and failed command blocks', () => {
    expect(
      summarizeToolBlocks([
        tool('read-1', "/bin/zsh -lc 'sed -n 1,5p file.jsonl'"),
        tool('search-1', "/bin/zsh -lc 'rg session_meta .'"),
        tool('cmd-1', "/bin/zsh -lc 'jq -r .type file.jsonl'"),
        tool('failed-1', "/bin/zsh -lc 'wc -l missing.jsonl'", 'error'),
      ])
    ).toBe('已探索 1 个文件 1 次搜索 已运行 1 条命令 运行失败 1 条命令')
  })

  test('groups completed tools while preserving running tools as standalone rows', () => {
    const thinking: ProcessingBlock = {
      id: 'thinking-1',
      subtaskId: 1,
      type: 'thinking',
      content: 'Reading context',
      status: 'done',
      createdAt: 1770000000000,
    }
    const rows = buildProcessingDisplayRows([
      thinking,
      tool('search-1', 'find . -name package.json'),
      tool('cmd-1', 'python3 analyze.py', 'streaming'),
      tool('read-1', 'cat README.md'),
    ])

    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({ type: 'block', id: 'thinking-1' })
    expect(rows[1]).toMatchObject({
      type: 'activity_group',
      label: '已探索 1 次搜索',
    })
    expect(rows[2]).toMatchObject({ type: 'block', id: 'cmd-1' })
    expect(rows[3]).toMatchObject({
      type: 'activity_group',
      label: '已探索 1 个文件',
    })
  })
})
