import { describe, expect, test, vi } from 'vitest'
import { createResponseApiStreamState, emitResponseApiEvent } from './responseApiStream'

describe('emitResponseApiEvent', () => {
  test('reads text delta offsets from response data', () => {
    const onChatChunk = vi.fn()

    emitResponseApiEvent(
      { onChatChunk },
      'response.output_text.delta',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          delta: 'hello',
          offset: 5,
        },
      },
      createResponseApiStreamState()
    )

    expect(onChatChunk).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      content: 'hello',
      offset: 5,
      result: {
        delta: 'hello',
        offset: 5,
      },
    })
  })

  test('leaves text delta offsets undefined when the stream omits them', () => {
    const onChatChunk = vi.fn()

    emitResponseApiEvent(
      { onChatChunk },
      'response.output_text.delta',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          delta: 'hello',
        },
      },
      createResponseApiStreamState()
    )

    expect(onChatChunk.mock.calls[0]?.[0]).not.toHaveProperty('offset')
  })

  test('does not treat full output snapshots as text deltas', () => {
    const onChatChunk = vi.fn()

    emitResponseApiEvent(
      { onChatChunk },
      'response.output_text.delta',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          value: 'full snapshot',
          output_text: 'full output',
        },
      },
      createResponseApiStreamState()
    )

    expect(onChatChunk).not.toHaveBeenCalled()
  })

  test('emits subagent activity payloads', () => {
    const onSubagentActivity = vi.fn()

    emitResponseApiEvent(
      { onSubagentActivity },
      'response.subagent.activity',
      {
        taskId: 'task-1',
        subtaskId: '2',
        deviceId: 'device-1',
        data: {
          agent_path: '/root/worker',
          agent_name: 'worker',
          agent_thread_id: 'thread-1',
          kind: 'started',
          status: 'running',
          occurred_at_ms: 12345,
        },
      },
      createResponseApiStreamState()
    )

    expect(onSubagentActivity).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      deviceId: 'device-1',
      agentPath: '/root/worker',
      agentName: 'worker',
      agentThreadId: 'thread-1',
      kind: 'started',
      status: 'running',
      occurredAtMs: 12345,
    })
  })
})
