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

  test('emits file changes block updates', () => {
    const onBlockUpdated = vi.fn()

    emitResponseApiEvent(
      { onBlockUpdated },
      'response.block.updated',
      {
        taskId: 'task-1',
        subtaskId: '2',
        deviceId: 'device-1',
        data: {
          block_id: 'file-changes-call-1',
          updates: {
            status: 'streaming',
            file_changes: {
              version: 1,
              status: 'active',
              artifact_id: 'artifact-1',
              device_id: 'device-1',
              workspace_path: '/repo',
              file_count: 1,
              additions: 2,
              deletions: 1,
              files: [],
              reverted_at: null,
              revertible: false,
            },
          },
        },
      },
      createResponseApiStreamState()
    )

    expect(onBlockUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      deviceId: 'device-1',
      blockId: 'file-changes-call-1',
      status: 'streaming',
      fileChanges: expect.objectContaining({
        additions: 2,
        deletions: 1,
      }),
    })
  })

  test('treats command output with non-zero exit code as completed', () => {
    const onBlockUpdated = vi.fn()

    emitResponseApiEvent(
      { onBlockUpdated },
      'response.output_item.done',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          item: {
            id: 'call-1',
            type: 'shell_call',
            status: 'failed',
            output: 'usage error',
            exit_code: 2,
          },
        },
      },
      createResponseApiStreamState()
    )

    expect(onBlockUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      blockId: 'call-1',
      status: 'done',
      toolOutput: 'usage error',
    })
  })

  test('keeps command startup failures without exit code as failed', () => {
    const onBlockUpdated = vi.fn()

    emitResponseApiEvent(
      { onBlockUpdated },
      'response.output_item.done',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          item: {
            id: 'call-1',
            type: 'shell_call',
            status: 'failed',
            output: 'spawn ENOENT',
          },
        },
      },
      createResponseApiStreamState()
    )

    expect(onBlockUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      blockId: 'call-1',
      status: 'error',
      toolOutput: 'spawn ENOENT',
    })
  })
})
