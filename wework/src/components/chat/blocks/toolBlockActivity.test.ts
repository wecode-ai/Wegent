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
    subtaskId: 1,
    type: 'tool',
    toolName,
    toolInput: toolName === 'exec_command' ? { cmd: command } : { command },
    status,
    createdAt: 1770000000000,
  }
}

function fileChangesBlock(
  id: string,
  path: string,
  additions: number,
  deletions: number,
  createdAt = 1770000000000
): ProcessingBlock {
  return {
    id,
    subtaskId: 1,
    type: 'file_changes',
    status: 'done',
    createdAt,
    fileChanges: {
      version: 1,
      status: 'active',
      artifact_id: id,
      device_id: 'device-1',
      workspace_path: '/tmp/project',
      file_count: 1,
      additions,
      deletions,
      files: [
        {
          path,
          change_type: 'modified',
          additions,
          deletions,
          binary: false,
        },
      ],
      diff: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    },
  }
}

describe('toolBlockActivity', () => {
  test('groups consecutive completed tools by activity type', () => {
    const rows = buildProcessingDisplayRows([
      tool('read-1', "sed -n '1,5p' first.ts"),
      tool('read-2', 'cat second.ts'),
      tool('search-1', 'rg session_meta .'),
      tool('cmd-1', 'node inspect.js'),
    ])

    expect(rows).toHaveLength(3)
    expect(rows.map(row => (row.type === 'activity_group' ? row.label : ''))).toEqual([
      '已读取 2 个文件',
      '已搜索代码',
      '已运行 1 条命令',
    ])
  })

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

    expect(
      getToolActivityFilePaths(
        tool('sed-multiline', "sed -n '1222,1245p' Cargo.toml\nsed -n '1940,1955p' Cargo.toml")
      )
    ).toEqual(['Cargo.toml'])
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

  test('hides internal stdin polling tools from activity rows', () => {
    const rows = buildProcessingDisplayRows([
      {
        id: 'guidance-1',
        subtaskId: 1,
        type: 'tool',
        toolName: 'conversation_guidance',
        toolInput: { message: 'follow this file' },
        status: 'done',
        createdAt: 1770000000000,
      },
      {
        id: 'stdin-1',
        subtaskId: 1,
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

  test('merges consecutive file changes into a single display row', () => {
    const rows = buildProcessingDisplayRows([
      fileChangesBlock('file-changes-1', 'src/config.ts', 3, 3),
      fileChangesBlock('file-changes-2', 'src/config.ts', 3, 0, 1770000000001),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'block',
      id: 'file-changes-file-changes-1-file-changes-2',
      block: {
        type: 'file_changes',
        fileChanges: {
          file_count: 1,
          additions: 6,
          deletions: 3,
          files: [
            {
              path: 'src/config.ts',
              additions: 6,
              deletions: 3,
            },
          ],
        },
      },
    })
  })

  test('does not merge file changes across ordinary activity', () => {
    const rows = buildProcessingDisplayRows([
      fileChangesBlock('file-changes-1', 'src/config.ts', 3, 3),
      {
        id: 'text-1',
        subtaskId: 1,
        type: 'text',
        content: 'Explaining the edit.',
        status: 'done',
        createdAt: 1770000000001,
      },
      fileChangesBlock('file-changes-2', 'src/config.ts', 3, 0, 1770000000002),
    ])

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ type: 'block', id: 'file-changes-1' })
    expect(rows[1]).toMatchObject({ type: 'block', id: 'text-1' })
    expect(rows[2]).toMatchObject({ type: 'block', id: 'file-changes-2' })
  })

  test('classifies Claude multi-file edit tools as edit activity', () => {
    expect(
      summarizeToolBlocks([
        {
          id: 'edit-1',
          subtaskId: 1,
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
      tool('read-before-1', 'cat README.md'),
      {
        id: 'ctx-1',
        subtaskId: 1,
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
