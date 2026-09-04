import { describe, expect, it } from 'vitest'

import type { ChatProcessingBlock, ChatToolBlock } from '@/types/runtime'
import {
  buildMessageDisplayRows,
  buildMessageDisplaySegments,
  buildThinkingPreview,
  generatedImagesFromBlocks,
  getToolActivityKind,
  processingActivityStats,
  processingDurationLabel,
  processingSegmentTitle,
  shouldCollapseCompletedProcessing,
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
      { type: 'tool-group', label: '已搜索网页' },
    ])
  })

  it('groups consecutive completed tools by Wework activity kind', () => {
    const rows = buildMessageDisplayRows(
      [tool('web-1', 'web_search'), tool('web-2', 'web_search'), tool('read-1', 'read_file')],
      ''
    )

    expect(rows).toMatchObject([
      { type: 'tool-group', kind: 'web', label: '已搜索网页' },
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
    expect(getToolActivityKind(tool('edit-1', 'mcp__codex__edit_file'))).toBe('edit')
    expect(getToolActivityKind(tool('read-2', 'functions.read_file'))).toBe('file')
    expect(getToolActivityKind(tool('repl-1', 'mcp__node_repl__js'))).toBe('command')
  })

  it('reduces active thinking to the latest plain-text sentence', () => {
    expect(buildThinkingPreview('先分析。\n\n**现在检查** `App.tsx`！')).toBe('现在检查 App.tsx')
  })

  it('uses file change blocks instead of the redundant completed patch tool', () => {
    const blocks: ChatProcessingBlock[] = [
      tool('patch-1', 'apply_patch', 'done', { patch: '*** Add File: abc.txt' }),
      {
        id: 'files-1',
        subtaskId: 'turn-1',
        type: 'file_changes',
        status: 'done',
        createdAt: 2,
        fileChanges: {
          fileCount: 1,
          additions: 1,
          deletions: 0,
          files: [
            {
              path: 'abc.txt',
              changeType: 'created',
              additions: 1,
              deletions: 0,
              binary: false,
            },
          ],
        },
      },
    ]

    expect(buildMessageDisplayRows(blocks, '完成')).toMatchObject([
      {
        type: 'file-changes',
        block: { fileChanges: { files: [{ path: 'abc.txt', changeType: 'created' }] } },
      },
    ])
  })

  it('collapses completed processing while keeping only the final answer outside', () => {
    const blocks = [
      tool('search-1', 'exec_command', 'done', { cmd: 'rg abc .' }),
      {
        id: 'intermediate-1',
        subtaskId: 'turn-1',
        type: 'text' as const,
        content: '先检查目录。',
        status: 'done' as const,
        createdAt: 2_000,
      },
    ]
    const rows = buildMessageDisplayRows(blocks, '已经完成。')

    expect(shouldCollapseCompletedProcessing(blocks, '已经完成。', rows)).toBe(true)
    expect(processingDurationLabel(blocks, 1_000, 12_000)).toBe('已处理 11 秒')
  })

  it('matches Wework processing segments and aggregate tool stats', () => {
    const blocks: ChatProcessingBlock[] = [
      tool('search-1', 'exec_command', 'done', { cmd: 'rg abc src' }),
      tool('read-1', 'read_file', 'done', { path: 'src/App.tsx' }),
      {
        id: 'narrative-1',
        subtaskId: 'turn-1',
        type: 'text',
        content: '接着修改文件。',
        status: 'done',
        createdAt: 2,
      },
      {
        id: 'files-1',
        subtaskId: 'turn-1',
        type: 'file_changes',
        status: 'done',
        createdAt: 3,
        fileChanges: {
          fileCount: 2,
          additions: 3,
          deletions: 1,
          files: [
            {
              path: 'src/App.tsx',
              changeType: 'modified',
              additions: 2,
              deletions: 1,
              binary: false,
            },
            {
              path: 'src/new.ts',
              changeType: 'created',
              additions: 1,
              deletions: 0,
              binary: false,
            },
          ],
        },
      },
    ]

    const segments = buildMessageDisplaySegments(blocks, '完成。')

    expect(segments.map(segment => segment.kind)).toEqual(['tool', 'narrative', 'tool'])
    expect(processingActivityStats(segments[0]!.rows)).toEqual({
      command: 0,
      file: 1,
      search: 1,
      edit: 0,
      other: 0,
    })
    expect(processingSegmentTitle(segments[0]!.rows)).toBe('调用 2 个工具')
    expect(processingSegmentTitle(segments[2]!.rows)).toBe('编辑 2 个文件')
  })

  it('keeps every supported special block in the same presentation pipeline', () => {
    const request = tool('request-1', 'request_user_input')
    request.renderPayload = {
      kind: 'request_user_input',
      questions: [{ header: '选择', question: '继续吗？', options: [{ label: '继续' }] }],
    }
    const image = tool('image-1', 'image_generation')
    image.renderPayload = {
      kind: 'image_generation',
      imageBase64: 'aW1hZ2U=',
      revisedPrompt: 'A generated preview',
    }
    const blocks: ChatProcessingBlock[] = [
      {
        id: 'thinking-1',
        subtaskId: 'turn-1',
        type: 'thinking',
        content: '内部思考',
        status: 'done',
        createdAt: 1,
      },
      tool('guidance-1', 'conversation_guidance'),
      tool('compact-1', 'contextcompaction'),
      request,
      image,
      {
        id: 'plan-1',
        subtaskId: 'turn-1',
        type: 'plan',
        content: '执行计划',
        status: 'done',
        createdAt: 2,
      },
      {
        id: 'error-1',
        subtaskId: 'turn-1',
        type: 'error',
        content: '执行失败',
        status: 'error',
        createdAt: 3,
      },
    ]

    const segments = buildMessageDisplaySegments(blocks, '')
    const visibleIds = segments.flatMap(segment => segment.rows.map(row => row.id))

    expect(visibleIds.some(id => id.includes('thinking-1'))).toBe(false)
    expect(visibleIds).toContain('guidance-1')
    expect(visibleIds).toContain('compact-1')
    expect(visibleIds).toContain('request-1')
    expect(visibleIds).toContain('image-1')
    expect(visibleIds).toContain('plan-1')
    expect(visibleIds).toContain('error-1')
    expect(generatedImagesFromBlocks(blocks)).toEqual([
      {
        id: 'image-1',
        uri: 'data:image/png;base64,aW1hZ2U=',
        alt: 'A generated preview',
      },
    ])
  })

  it('hides transport-only tools but preserves an active reconnect indicator', () => {
    const rows = buildMessageDisplayRows(
      [
        tool('stdin-1', 'write_stdin'),
        tool('reconnect-done', 'runtime_reconnecting'),
        tool('reconnect-live', 'runtime_reconnecting', 'streaming'),
      ],
      ''
    )

    expect(rows).toMatchObject([{ type: 'tool', id: 'reconnect-live' }])
  })

  it('merges consecutive file change snapshots like Wework', () => {
    const makeFileChange = (id: string, additions: number): ChatProcessingBlock => ({
      id,
      subtaskId: 'turn-1',
      type: 'file_changes',
      status: 'done',
      createdAt: additions,
      fileChanges: {
        fileCount: 1,
        additions,
        deletions: 0,
        files: [
          {
            path: 'src/App.tsx',
            changeType: 'modified',
            additions,
            deletions: 0,
            binary: false,
          },
        ],
      },
    })

    expect(
      buildMessageDisplayRows([makeFileChange('files-1', 1), makeFileChange('files-2', 2)], '')
    ).toMatchObject([
      {
        type: 'file-changes',
        block: { fileChanges: { fileCount: 1, additions: 3, files: [{ additions: 3 }] } },
      },
    ])
  })
})
