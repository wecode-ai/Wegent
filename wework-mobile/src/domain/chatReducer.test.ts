import { describe, expect, it } from 'vitest'

import { appendDelta, chatReducer, type RuntimeStreamEvent } from './chatReducer'
import { projectMobileRuntimeTranscript } from './runtimeTranscript'
import { hydrateRuntimeTranscript } from './runtimeTranscriptHydration'
import type { Attachment } from '@/types/runtime'

const attachment: Attachment = {
  id: 17,
  filename: 'report.png',
  file_size: 120,
  mime_type: 'image/png',
  status: 'ready',
  file_extension: 'png',
  created_at: '2026-11-14T10:00:00Z',
  workspace_file: { device_id: 'storage-device', workspace_path: '/worktree', path: 'report.png' },
  image_width: 320,
  image_height: 180,
  ui_group_id: 'artifact',
  ui_group_role: 'primary',
  ui_kind: 'appshot',
}

function stream(state: ReturnType<typeof chatReducer>, event: RuntimeStreamEvent) {
  return chatReducer(state, { type: 'stream', event })
}

describe('chatReducer', () => {
  it('preserves canonical diff identity and bytes on transcript summaries and blocks', () => {
    const source = {
      version: 1 as const,
      status: 'active' as const,
      artifact_id: 'artifact',
      device_id: 'storage',
      workspace_path: '/original',
      file_count: 1,
      additions: 1,
      deletions: 0,
      files: [
        {
          path: 'a.ts',
          change_type: 'created' as const,
          additions: 1,
          deletions: 0,
          binary: false,
        },
      ],
      diff: 'diff --git a/a.ts b/a.ts\n+hello',
    }
    const [message] = chatReducer([], {
      type: 'replace',
      messages: [
        {
          id: 'assistant',
          role: 'assistant',
          content: '',
          subtaskId: 'turn',
          blocks: [{ id: 'changes', type: 'file_changes', file_changes: source, status: 'done' }],
        },
      ],
    })
    expect(message.fileChanges?.source).toMatchObject(source)
    expect(message.blocks?.[0]).toMatchObject({ fileChanges: { source } })
    const streamed = stream([], {
      name: 'response.completed',
      payload: { subtaskId: 'turn', data: { file_changes: source } },
    })
    expect(streamed[0].fileChanges?.source).toMatchObject(source)
  })
  it('keeps complete attachment metadata through canonical projection and message hydration', () => {
    const transcript = projectMobileRuntimeTranscript({
      taskId: 'task',
      workspacePath: '/worktree',
      runtime: 'codex',
      messages: [],
      runtimeTurns: [],
      turns: [
        {
          id: 'turn',
          status: 'completed',
          items: [
            {
              id: 'input',
              type: 'user_message',
              message: {
                id: 'provider-user',
                clientUserMessageId: 'user',
                role: 'user',
                content: 'Inspect',
                attachments: [attachment],
              },
            },
          ],
        },
      ],
    })
    const [message] = chatReducer([], { type: 'replace', messages: transcript.messages })
    expect(message.id).toBe('user')
    expect(message.attachments).toEqual([attachment])
  })

  it('retains optimistic attachments when confirmation and reconnect omit optional metadata', () => {
    const optimistic = chatReducer([], {
      type: 'optimistic-user',
      id: 'user',
      content: 'Inspect',
      createdAt: 10,
      attachments: [attachment],
    })
    const delivered = chatReducer(optimistic, { type: 'user-delivered', id: 'user' })
    expect(delivered[0]).toMatchObject({ attachments: [attachment], pendingDelivery: false })
    const result = hydrateRuntimeTranscript(
      delivered,
      {
        taskId: 'task',
        workspacePath: '/worktree',
        runtime: 'codex',
        messages: [
          { id: 'provider-user', clientUserMessageId: 'user', role: 'user', content: 'Inspect' },
        ],
      },
      [],
      true
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].attachments).toEqual([attachment])
  })

  it('accepts authoritative attachment updates and explicit removal without reviving old attachments', () => {
    const original = chatReducer([], {
      type: 'replace',
      messages: [{ id: 'user', role: 'user', content: 'Inspect', attachments: [attachment] }],
    })
    const updated = { ...attachment, filename: 'renamed.png', image_width: 640 }
    const merged = chatReducer(original, {
      type: 'merge-latest',
      messages: [{ id: 'user', role: 'user', content: 'Inspect', attachments: [updated] }],
    })
    expect(merged[0].attachments).toEqual([updated])
    const removed = chatReducer(merged, {
      type: 'merge-latest',
      messages: [{ id: 'user', role: 'user', content: 'Inspect', attachments: [] }],
    })
    const prepended = chatReducer(removed, {
      type: 'prepend',
      messages: [{ id: 'user', role: 'user', content: 'Inspect', attachments: [attachment] }],
    })
    expect(prepended[0].attachments).toEqual([])
  })

  it('does not lose attachments at an overlapping pagination boundary', () => {
    const current = chatReducer([], {
      type: 'replace',
      messages: [{ id: 'user', role: 'user', content: 'Inspect' }],
    })
    const prepended = chatReducer(current, {
      type: 'prepend',
      messages: [{ id: 'user', role: 'user', content: 'Inspect', attachments: [attachment] }],
    })
    expect(prepended).toHaveLength(1)
    expect(prepended[0].attachments).toEqual([attachment])
  })

  it('joins a streamed reply to its canonical reconnect snapshot without duplicating it', () => {
    const previous = stream([], {
      name: 'response.output_text.delta',
      payload: { subtaskId: 'turn-1', data: { itemId: 'reply', delta: 'Hel', offset: 0 } },
    })
    const transcript = projectMobileRuntimeTranscript({
      taskId: 'task-1',
      workspacePath: '/work',
      runtime: 'codex',
      messages: [],
      runtimeTurns: [],
      turns: [
        {
          id: 'turn-1',
          status: 'inProgress',
          items: [{ id: 'reply', type: 'assistant_text', content: 'Hel' }],
        },
      ],
    })
    const result = hydrateRuntimeTranscript(
      previous,
      transcript,
      [
        {
          type: 'stream',
          event: {
            name: 'response.output_text.delta',
            payload: { subtaskId: 'turn-1', data: { itemId: 'reply', delta: 'lo', offset: 3 } },
          },
        },
      ],
      true
    )
    expect(result.resetPagination).toBe(false)
    expect(result.messages).toMatchObject([
      {
        id: previous[0].id,
        subtaskId: 'turn-1',
        content: 'Hello',
        textItems: [{ id: 'reply', content: 'Hello' }],
        status: 'streaming',
      },
    ])
  })

  it('continues the latest guidance view while late tool updates retain their original owner', () => {
    const transcript = projectMobileRuntimeTranscript({
      taskId: 'task-1',
      workspacePath: '/work',
      runtime: 'codex',
      messages: [],
      runtimeTurns: [],
      turns: [
        {
          id: 'turn-1',
          status: 'inProgress',
          items: [
            { id: 'before', type: 'assistant_text', content: 'Inspect' },
            {
              id: 'command',
              type: 'block',
              block: { id: 'command', type: 'tool', tool_name: 'bash', status: 'pending' },
            },
            {
              id: 'guide',
              type: 'user_message',
              message: { id: 'guide', role: 'user', content: 'Fix it', runtimeGuidance: true },
            },
            { id: 'after', type: 'assistant_text', content: 'Fi' },
          ],
        },
      ],
    })
    const initial = chatReducer([], { type: 'replace', messages: transcript.messages })
    const continued = stream(initial, {
      name: 'response.output_text.delta',
      payload: { subtaskId: 'turn-1', data: { itemId: 'after', delta: 'xed', offset: 2 } },
    })
    const result = stream(continued, {
      name: 'response.block.updated',
      payload: { subtaskId: 'turn-1', data: { blockId: 'command', updates: { status: 'done' } } },
    })
    expect(result.map(message => message.content)).toEqual(['Inspect', 'Fix it', 'Fixed'])
    expect(result[0].blocks?.find(block => block.id === 'command')?.status).toBe('done')
    expect(result[2].blocks?.some(block => block.id === 'command')).toBe(false)
  })

  it('hydrates canonical transcript identity, blocks, status, errors and timestamps', () => {
    const result = chatReducer([], {
      type: 'replace',
      messages: [
        {
          id: 'provider-user-id',
          clientUserMessageId: 'user-1',
          role: 'user',
          content: '开始',
          createdAt: 1788099302000,
        },
        {
          id: 'assistant-1',
          subtaskId: 'turn-1',
          role: 'assistant',
          content: '# 完成',
          status: 'completed',
          blocks: [
            {
              id: 'tool-1',
              type: 'tool',
              tool_name: 'bash',
              status: 'done',
              createdAt: 1788099303000,
            },
          ],
        },
      ],
    })

    expect(result[0]).toMatchObject({ id: 'user-1', createdAt: 1788099302000 })
    expect(result[1]).toMatchObject({
      id: 'assistant-1',
      subtaskId: 'turn-1',
      content: '# 完成',
      status: 'completed',
      blocks: [{ id: 'tool-1', type: 'tool', toolName: 'bash', status: 'done' }],
    })
  })

  it('hides injected application context from historical and optimistic user messages', () => {
    const runtimeContent = [
      '<application_context>',
      '[cloudCollaboration]',
      'Current task: WORK-567',
      '</application_context>',
      '',
      '本地启动后无法流式输出',
    ].join('\n')
    const historical = chatReducer([], {
      type: 'replace',
      messages: [{ id: 'user-history', role: 'user', content: runtimeContent }],
    })
    const optimistic = chatReducer(historical, {
      type: 'optimistic-user',
      id: 'user-live',
      content: runtimeContent,
      createdAt: 1788099302000,
    })

    expect(optimistic.map(message => message.content)).toEqual([
      '本地启动后无法流式输出',
      '本地启动后无法流式输出',
    ])
  })

  it('prepends an older transcript page without duplicating boundary messages', () => {
    const recent = chatReducer([], {
      type: 'replace',
      messages: [
        { id: 'message-5', role: 'user', content: 'recent' },
        { id: 'message-6', role: 'assistant', content: 'latest' },
      ],
    })
    const combined = chatReducer(recent, {
      type: 'prepend',
      messages: [
        { id: 'message-4', role: 'assistant', content: 'older' },
        { id: 'message-5', role: 'user', content: 'recent' },
      ],
    })

    expect(combined.map(message => message.id)).toEqual(['message-4', 'message-5', 'message-6'])
  })

  it('restores file change blocks and the turn summary from transcript history', () => {
    const [message] = chatReducer([], {
      type: 'replace',
      messages: [
        {
          id: 'assistant-file-edit',
          subtaskId: 'turn-file-edit',
          role: 'assistant',
          content: '已写入 abc.txt。',
          status: 'completed',
          blocks: [
            {
              id: 'apply-patch-1',
              type: 'tool',
              tool_name: 'apply_patch',
              status: 'done',
            },
            {
              id: 'file-changes-1',
              type: 'file_changes',
              status: 'done',
              file_changes: {
                file_count: 1,
                additions: 1,
                deletions: 0,
                files: [
                  {
                    path: 'abc.txt',
                    change_type: 'created',
                    additions: 1,
                    deletions: 0,
                    binary: false,
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    expect(message).toMatchObject({
      fileChanges: { fileCount: 1, additions: 1, deletions: 0 },
      blocks: [
        { type: 'tool', toolName: 'apply_patch' },
        {
          type: 'file_changes',
          fileChanges: { files: [{ path: 'abc.txt', changeType: 'created' }] },
        },
      ],
    })
  })

  it('assembles Wework reasoning and Markdown output by subtask and item identity', () => {
    const started = stream([], {
      name: 'response.created',
      payload: { taskId: 'task-1', subtaskId: 'turn-1', data: {} },
    })
    const reasoning = stream(started, {
      name: 'response.reasoning_summary_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { delta: '分析', offset: 0 },
      },
    })
    const output = stream(reasoning, {
      name: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { item_id: 'item-1', delta: '# 标题\n\n- 条目', offset: 0 },
      },
    })

    expect(reasoning[0]).toMatchObject({
      id: 'runtime-view:turn-1:assistant',
      streamingThinkingContent: '分析',
      status: 'streaming',
      blocks: [{ type: 'thinking', content: '分析' }],
    })
    expect(output[0]).toMatchObject({
      content: '# 标题\n\n- 条目',
      textItems: [{ id: 'item-1', content: '# 标题\n\n- 条目' }],
      streamingThinkingContent: undefined,
      status: 'streaming',
    })
  })

  it('uses output_text.done as an authoritative item snapshot', () => {
    const partial = stream([], {
      name: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { itemId: 'item-1', delta: '半成', offset: 0 },
      },
    })
    const done = stream(partial, {
      name: 'response.output_text.done',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { itemId: 'item-1', text: '完整内容' },
      },
    })

    expect(done[0]).toMatchObject({
      content: '完整内容',
      textItems: [{ id: 'item-1', content: '完整内容' }],
    })
  })

  it('moves text before a tool block and updates the tool lifecycle', () => {
    const text = stream([], {
      name: 'response.output_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { itemId: 'item-1', delta: '先解释', offset: 0 },
      },
    })
    const tool = stream(text, {
      name: 'response.output_item.added',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { item: { id: 'call-1', type: 'shell_call', name: 'exec_command' } },
      },
    })
    const completed = stream(tool, {
      name: 'response.output_item.done',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { item: { id: 'call-1', type: 'shell_call', output: 'ok' } },
      },
    })

    expect(tool[0]?.content).toBe('')
    expect(tool[0]?.blocks).toMatchObject([
      { type: 'text', content: '先解释', status: 'done' },
      { id: 'call-1', type: 'tool', toolName: 'bash', status: 'pending' },
    ])
    expect(completed[0]?.blocks?.[1]).toMatchObject({ status: 'done', toolOutput: 'ok' })
  })

  it('applies response block creation and incremental updates', () => {
    const created = stream([], {
      name: 'response.block.created',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: {
          block: {
            id: 'plan-1',
            type: 'plan',
            content: '第一步',
            status: 'streaming',
            timestamp: 100,
          },
        },
      },
    })
    const updated = stream(created, {
      name: 'response.block.updated',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: {
          blockId: 'plan-1',
          updates: { contentDelta: '\n第二步', status: 'done', durationMs: 25 },
        },
      },
    })

    expect(updated[0]?.blocks?.[0]).toMatchObject({
      id: 'plan-1',
      content: '第一步\n第二步',
      status: 'done',
      durationMs: 25,
      completedAt: 125,
    })
  })

  it('uses the completed response as canonical Markdown and settles open blocks', () => {
    const partial = stream([], {
      name: 'response.reasoning_summary_text.delta',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { delta: '思考' },
      },
    })
    const completed = stream(partial, {
      name: 'response.completed',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: {
          response: {
            output: [
              {
                content: [{ type: 'output_text', text: '**粗体**\n\n```ts\nconst ok = true\n```' }],
              },
            ],
            file_changes: {
              file_count: 41,
              additions: 12_000,
              deletions: 0,
              files: [
                {
                  path: 'src/App.tsx',
                  change_type: 'modified',
                  additions: 8,
                  deletions: 0,
                  binary: false,
                },
              ],
            },
          },
        },
      },
    })

    expect(completed[0]).toMatchObject({
      content: '**粗体**\n\n```ts\nconst ok = true\n```',
      streamingThinkingContent: undefined,
      status: 'completed',
      blocks: [{ type: 'thinking', status: 'done' }],
      fileChanges: {
        fileCount: 41,
        additions: 12_000,
        deletions: 0,
        files: [{ path: 'src/App.tsx', changeType: 'modified' }],
      },
    })
  })

  it('surfaces terminal stream failures only when Wework subtask identity exists', () => {
    const dropped = stream([], {
      name: 'response.failed',
      payload: { taskId: 'task-1', data: { error: { message: 'missing identity' } } },
    })
    const failed = stream([], {
      name: 'response.failed',
      payload: {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: { error: { message: 'executor offline' } },
      },
    })

    expect(dropped).toEqual([])
    expect(failed[0]).toMatchObject({
      subtaskId: 'turn-1',
      status: 'failed',
      error: 'executor offline',
    })
  })

  it('does not duplicate replayed unicode deltas at the same code-point offset', () => {
    expect(appendDelta('你🙂', '🙂', 1)).toBe('你🙂')
    expect(appendDelta('你🙂', '！', 2)).toBe('你🙂！')
  })
})
