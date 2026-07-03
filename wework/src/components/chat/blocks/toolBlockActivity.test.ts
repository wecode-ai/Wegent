import { describe, expect, test } from 'vitest'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'
import {
  buildProcessingDisplayRows,
  getToolActivityFilePaths,
  getToolActivitySearchItem,
  summarizeToolBlocks,
} from './toolBlockActivity'

function tool(
  id: string,
  command: string,
  status: ToolBlock['status'] = 'done',
  toolName = 'bash'
): ToolBlock {
  return {
    id,
    turnId: 1,
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
          turnId: 1,
          type: 'tool',
          toolName: 'bash',
          toolInput: { commandLine: 'find . -name package.json' },
          status: 'done',
          createdAt: 1770000000000,
        },
      ])
    ).toBe('已搜索代码')
  })

  test('extracts read file paths from shell read commands', () => {
    expect(
      getToolActivityFilePaths(
        tool('nl-1', 'nl -ba wework/src/components/chat/blocks/toolBlockActivity.ts')
      )
    ).toEqual(['wework/src/components/chat/blocks/toolBlockActivity.ts'])

    expect(
      getToolActivityFilePaths(
        tool(
          'sed-1',
          '/bin/zsh -lc "sed -n \'1,120p\' wework/src/components/chat/blocks/toolBlockKinds.ts"'
        )
      )
    ).toEqual(['wework/src/components/chat/blocks/toolBlockKinds.ts'])
  })

  test('extracts code search summaries from shell search commands', () => {
    expect(
      getToolActivitySearchItem({
        ...tool(
          'rg-1',
          '/bin/zsh -lc "rg -n \'ToolBlockItem|toolBlock|file_changes|renderPayload|read.*file|command\'"'
        ),
        toolInput: {
          command:
            '/bin/zsh -lc "rg -n \'ToolBlockItem|toolBlock|file_changes|renderPayload|read.*file|command\'"',
          workdir: '/Users/crystal/dev/git/Wegent/wework/src/components/chat/blocks',
        },
      })
    ).toMatchObject({
      query: 'ToolBlockItem|toolBlock|file_changes|renderPayload|read.*file|command',
      scope: 'blocks',
      label:
        'Searched for ToolBlockItem|toolBlock|file_changes|renderPayload|read.*file|command in blocks',
    })

    expect(
      getToolActivitySearchItem(tool('rg-2', "rg -n '已编辑|edited|edited_file|edit.*file' wework"))
    ).toMatchObject({
      query: '已编辑|edited|edited_file|edit.*file',
      scope: 'wework',
      label: 'Searched for 已编辑|edited|edited_file|edit.*file in wework',
    })
  })

  test('summarizes mid-turn user guidance activity', () => {
    expect(
      summarizeToolBlocks([
        {
          id: 'guidance-1',
          turnId: 1,
          type: 'tool',
          toolName: 'conversation_guidance',
          toolInput: { message: 'follow this file' },
          status: 'done',
          createdAt: 1770000000000,
        },
      ])
    ).toBe('已引导对话')
  })

  test('hides internal stdin polling tools from activity rows', () => {
    const rows = buildProcessingDisplayRows([
      {
        id: 'guidance-1',
        turnId: 1,
        type: 'tool',
        toolName: 'conversation_guidance',
        toolInput: { message: 'follow this file' },
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'stdin-1',
        turnId: 1,
        type: 'tool',
        toolName: 'write_stdin',
        toolInput: { session_id: 90870, chars: '' },
        status: 'done',
        createdAt: 1770000000001,
      },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'activity_group',
      label: '已引导对话',
    })
  })

  test('classifies Claude multi-file edit tools as edit activity', () => {
    expect(
      summarizeToolBlocks([
        {
          id: 'edit-1',
          turnId: 1,
          type: 'tool',
          toolName: 'MultiEdit',
          toolInput: {
            file_path: '/workspace/src/config.ts',
            edits: [
              {
                old_string: 'enabled: false',
                new_string: 'enabled: true',
              },
            ],
          },
          status: 'done',
          createdAt: 1770000000000,
        },
      ])
    ).toBe('已编辑 1 个文件')
  })

  test('groups completed tools while preserving context compaction and running tools as standalone rows', () => {
    const thinking: ProcessingBlock = {
      id: 'thinking-1',
      turnId: 1,
      type: 'thinking',
      content: 'Reading context',
      status: 'done',
      createdAt: 1770000000000,
    }
    const rows = buildProcessingDisplayRows([
      thinking,
      {
        id: 'text-1',
        turnId: 1,
        type: 'text',
        content: 'Let me inspect package files.',
        status: 'done',
        createdAt: 1770000000001,
      },
      tool('read-before-1', 'cat README.md'),
      {
        id: 'ctx-1',
        turnId: 1,
        type: 'tool',
        toolName: 'context_compaction',
        status: 'done',
        createdAt: 1770000000002,
      },
      tool('search-1', 'find . -name package.json'),
      tool('cmd-1', 'python3 analyze.py', 'streaming'),
      tool('read-1', 'cat README.md'),
    ])

    expect(rows).toHaveLength(7)
    expect(rows[0]).toMatchObject({ type: 'block', id: 'thinking-1' })
    expect(rows[1]).toMatchObject({ type: 'block', id: 'text-1' })
    expect(rows[2]).toMatchObject({
      type: 'activity_group',
      label: '已读取 1 个文件',
    })
    expect(rows[3]).toMatchObject({ type: 'block', id: 'ctx-1' })
    expect(rows[4]).toMatchObject({
      type: 'activity_group',
      label: '已搜索代码',
    })
    expect(rows[5]).toMatchObject({ type: 'block', id: 'cmd-1' })
    expect(rows[6]).toMatchObject({
      type: 'activity_group',
      label: '已读取 1 个文件',
    })
  })
})
