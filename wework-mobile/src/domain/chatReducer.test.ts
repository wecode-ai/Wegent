import { describe, expect, it } from 'vitest'

import { appendDelta, chatReducer, type RuntimeStreamEvent } from './chatReducer'

function stream(state: ReturnType<typeof chatReducer>, event: RuntimeStreamEvent) {
  return chatReducer(state, { type: 'stream', event })
}

describe('chatReducer', () => {
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
      id: 'assistant-turn-1',
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
