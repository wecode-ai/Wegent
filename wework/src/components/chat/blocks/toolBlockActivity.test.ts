import { describe, expect, test } from 'vitest'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import { buildProcessingDisplayRows, summarizeToolBlocks } from './toolBlockActivity'

function tool(
  id: string,
  command: string,
  status: ToolBlock['status'] = 'done',
  toolName = 'bash'
): ToolBlock {
  return {
    id,
    subtaskId: 1,
    type: 'tool',
    toolName,
    toolInput: toolName === 'exec_command' ? { cmd: command } : { command },
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
    ).toBe('已读取 1 个文件 已搜索代码 已运行 1 条命令 运行失败 1 条命令')
  })

  test('classifies Codex exec_command function calls as shell command activity', () => {
    expect(
      summarizeToolBlocks([
        tool('read-1', "sed -n '1,5p' file.jsonl", 'done', 'exec_command'),
        tool('search-1', 'rg session_meta .', 'done', 'exec_command'),
        tool('cmd-1', 'node inspect.js', 'done', 'exec_command'),
      ])
    ).toBe('已读取 1 个文件 已搜索代码 已运行 1 条命令')
  })

  test('classifies commandLine aliases as shell command activity', () => {
    expect(
      summarizeToolBlocks([
        {
          id: 'cmdline-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'bash',
          toolInput: { commandLine: 'find . -name package.json' },
          status: 'done',
          createdAt: 1770000000000,
        },
      ])
    ).toBe('已搜索代码')
  })

  test('summarizes mid-turn user guidance activity', () => {
    expect(
      summarizeToolBlocks([
        {
          id: 'guidance-1',
          subtaskId: 1,
          type: 'tool',
          toolName: 'conversation_guidance',
          toolInput: { message: 'follow this file' },
          status: 'done',
          createdAt: 1770000000000,
        },
      ])
    ).toBe('已引导对话')
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
      {
        id: 'text-1',
        subtaskId: 1,
        type: 'text',
        content: 'Let me inspect package files.',
        status: 'done',
        createdAt: 1770000000001,
      },
      tool('search-1', 'find . -name package.json'),
      tool('cmd-1', 'python3 analyze.py', 'streaming'),
      tool('read-1', 'cat README.md'),
    ])

    expect(rows).toHaveLength(5)
    expect(rows[0]).toMatchObject({ type: 'block', id: 'thinking-1' })
    expect(rows[1]).toMatchObject({ type: 'block', id: 'text-1' })
    expect(rows[2]).toMatchObject({
      type: 'activity_group',
      label: '已搜索代码',
    })
    expect(rows[3]).toMatchObject({ type: 'block', id: 'cmd-1' })
    expect(rows[4]).toMatchObject({
      type: 'activity_group',
      label: '已读取 1 个文件',
    })
  })
})
