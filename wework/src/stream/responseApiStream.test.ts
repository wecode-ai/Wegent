import { describe, expect, test, vi } from 'vitest'
import { createResponseApiStreamState, emitResponseApiEvent } from './responseApiStream'

describe('emitResponseApiEvent', () => {
  test('preserves a snake-case client user message id when a Codex turn starts', () => {
    const onChatStart = vi.fn()

    emitResponseApiEvent(
      { onChatStart },
      'response.created',
      {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: {
          client_user_message_id: 'client-user-1',
        },
      },
      createResponseApiStreamState()
    )

    expect(onChatStart).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        subtaskId: 'turn-1',
        clientUserMessageId: 'client-user-1',
      })
    )
  })

  test('preserves the Codex turn identifier on runtime goal updates', () => {
    const onRuntimeGoalUpdated = vi.fn()

    emitResponseApiEvent(
      { onRuntimeGoalUpdated },
      'runtime.goal.updated',
      {
        taskId: 'task-1',
        subtaskId: '2',
        deviceId: 'device-1',
        data: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          goal: { status: 'active' },
        },
      },
      createResponseApiStreamState()
    )

    expect(onRuntimeGoalUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      deviceId: 'device-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      goal: { status: 'active' },
    })
  })

  test('maps friendly task title updates', () => {
    const onRuntimeTaskTitleUpdated = vi.fn()

    emitResponseApiEvent(
      { onRuntimeTaskTitleUpdated },
      'runtime.task.title.updated',
      {
        taskId: 'task-1',
        subtaskId: 'friendly-title-turn',
        deviceId: 'device-1',
        data: { title: '测试标题生成功能' },
      },
      createResponseApiStreamState()
    )

    expect(onRuntimeTaskTitleUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: 'friendly-title-turn',
      deviceId: 'device-1',
      title: '测试标题生成功能',
    })
  })

  test('maps task supervisor state updates', () => {
    const onRuntimeSupervisorUpdated = vi.fn()
    const supervisor = {
      mode: 'suggest',
      status: 'active',
      instructions: 'Keep scope focused',
      suggestions: [],
    }

    emitResponseApiEvent(
      { onRuntimeSupervisorUpdated },
      'runtime.supervisor.updated',
      {
        taskId: 'task-1',
        subtaskId: 'supervisor-state-1',
        deviceId: 'device-1',
        data: { supervisor },
      },
      createResponseApiStreamState()
    )

    expect(onRuntimeSupervisorUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: 'supervisor-state-1',
      deviceId: 'device-1',
      supervisor,
    })
  })

  test('carries a generated supervisor user message on response start', () => {
    const onChatStart = vi.fn()

    emitResponseApiEvent(
      { onChatStart },
      'response.created',
      {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        deviceId: 'device-1',
        clientUserMessageId: 'supervisor-correction-1',
        runtimeGeneratedUserMessage: {
          id: 'supervisor-correction-1',
          message: 'Return to scope.',
          createdAt: 1234,
          source: { source: 'supervisor' },
        },
        data: { response: { status: 'in_progress' } },
      },
      createResponseApiStreamState()
    )

    expect(onChatStart).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      clientUserMessageId: 'supervisor-correction-1',
      runtimeGeneratedUserMessage: {
        id: 'supervisor-correction-1',
        message: 'Return to scope.',
        createdAt: 1234,
        source: { source: 'supervisor' },
      },
    })
  })

  test('maps root goal turn lifecycle events', () => {
    const onRuntimeGoalContinuation = vi.fn()
    const state = createResponseApiStreamState()

    for (const status of ['started', 'settled'] as const) {
      emitResponseApiEvent(
        { onRuntimeGoalContinuation },
        'runtime.goal.continuation',
        {
          taskId: 'task-1',
          subtaskId: '2',
          deviceId: 'device-1',
          data: { thread_id: 'thread-1', turn_id: 'turn-2', status },
        },
        state
      )
    }

    expect(onRuntimeGoalContinuation).toHaveBeenNthCalledWith(1, {
      taskId: 'task-1',
      subtaskId: '2',
      deviceId: 'device-1',
      threadId: 'thread-1',
      turnId: 'turn-2',
      status: 'started',
    })
    expect(onRuntimeGoalContinuation).toHaveBeenNthCalledWith(2, {
      taskId: 'task-1',
      subtaskId: '2',
      deviceId: 'device-1',
      threadId: 'thread-1',
      turnId: 'turn-2',
      status: 'settled',
    })
  })

  test('maps structured Codex task-plan updates without treating them as plan text', () => {
    const onRuntimePlanUpdated = vi.fn()

    emitResponseApiEvent(
      { onRuntimePlanUpdated },
      'runtime.plan.updated',
      {
        taskId: 'task-1',
        subtaskId: '2',
        deviceId: 'device-1',
        data: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: 'Working through the repository.',
          plan: [
            { step: 'Inspect the workspace', status: 'completed' },
            { step: 'Implement the UI', status: 'inProgress' },
            { step: 'Run tests', status: 'pending' },
          ],
        },
      },
      createResponseApiStreamState()
    )

    expect(onRuntimePlanUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      deviceId: 'device-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: 'Working through the repository.',
      plan: [
        { step: 'Inspect the workspace', status: 'completed' },
        { step: 'Implement the UI', status: 'inProgress' },
        { step: 'Run tests', status: 'pending' },
      ],
    })
  })

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

  test('maps completed Codex text to an item snapshot', () => {
    const onChatChunk = vi.fn()

    emitResponseApiEvent(
      { onChatChunk },
      'response.output_text.done',
      {
        taskId: 'task-1',
        subtaskId: 'turn-1',
        data: {
          itemId: 'message-1',
          text: 'Complete answer',
        },
      },
      createResponseApiStreamState()
    )

    expect(onChatChunk).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: 'turn-1',
      itemId: 'message-1',
      content: 'Complete answer',
      contentMode: 'snapshot',
      result: {
        itemId: 'message-1',
        text: 'Complete answer',
      },
    })
  })

  test('maps Codex token usage notifications to context usage chunks', () => {
    const onChatChunk = vi.fn()

    emitResponseApiEvent(
      { onChatChunk },
      'thread/tokenUsage/updated',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          tokenUsage: {
            total: {
              totalTokens: 15_000,
              inputTokens: 12_000,
              cachedInputTokens: 2_000,
              outputTokens: 3_000,
              reasoningOutputTokens: 0,
            },
            last: {
              totalTokens: 8_000,
              inputTokens: 7_000,
              cachedInputTokens: 1_000,
              outputTokens: 1_000,
              reasoningOutputTokens: 0,
            },
            modelContextWindow: 258_000,
          },
        },
      },
      createResponseApiStreamState()
    )

    expect(onChatChunk).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      content: '',
      result: {
        contextUsage: {
          total: {
            totalTokens: 15_000,
            inputTokens: 12_000,
            cachedInputTokens: 2_000,
            outputTokens: 3_000,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 8_000,
            inputTokens: 7_000,
            cachedInputTokens: 1_000,
            outputTokens: 1_000,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_000,
        },
      },
    })
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

  test('emits tool output delta block updates', () => {
    const onBlockUpdated = vi.fn()

    emitResponseApiEvent(
      { onBlockUpdated },
      'response.block.updated',
      {
        taskId: 'task-1',
        subtaskId: '2',
        deviceId: 'device-1',
        data: {
          block_id: 'call-1',
          updates: {
            status: 'streaming',
            tool_output_delta: 'line 1\n',
            tool_output_truncated: false,
          },
        },
      },
      createResponseApiStreamState()
    )

    expect(onBlockUpdated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      deviceId: 'device-1',
      blockId: 'call-1',
      status: 'streaming',
      toolOutputDelta: 'line 1\n',
      toolOutputTruncated: false,
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

  test('keeps non-command tool failures with exit code as failed', () => {
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
            type: 'function_call',
            status: 'failed',
            output: { exit_code: 2, message: 'tool failed' },
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
      status: 'error',
      toolOutput: { exit_code: 2, message: 'tool failed' },
    })
  })

  test('maps image generation lifecycle events to renderable tool blocks', () => {
    const onBlockCreated = vi.fn()
    const onBlockUpdated = vi.fn()
    const state = createResponseApiStreamState()

    emitResponseApiEvent(
      { onBlockCreated, onBlockUpdated },
      'response.output_item.added',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          item: { id: 'ig-1', type: 'image_generation_call', status: 'in_progress' },
        },
      },
      state
    )
    emitResponseApiEvent(
      { onBlockCreated, onBlockUpdated },
      'image_generation.partial_image',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: { item_id: 'ig-1', partial_image_b64: 'cGFydGlhbA==' },
      },
      state
    )
    emitResponseApiEvent(
      { onBlockCreated, onBlockUpdated },
      'response.output_item.done',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          item: {
            id: 'ig-1',
            type: 'image_generation_call',
            status: 'completed',
            revisedPrompt: 'A finished image',
            result: 'ZmluYWw=',
            partial_image_b64: 'cGFydGlhbA==',
            savedPath: '/tmp/generated.png',
          },
        },
      },
      state
    )

    expect(onBlockCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        block: expect.objectContaining({
          id: 'ig-1',
          type: 'tool',
          tool_name: 'image_generation',
        }),
      })
    )
    expect(onBlockUpdated).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        blockId: 'ig-1',
        status: 'streaming',
        renderPayload: { kind: 'image_generation', imageBase64: 'cGFydGlhbA==' },
      })
    )
    expect(onBlockUpdated).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        blockId: 'ig-1',
        status: 'done',
        renderPayload: {
          kind: 'image_generation',
          imageBase64: 'ZmluYWw=',
          revisedPrompt: 'A finished image',
          savedPath: '/tmp/generated.png',
        },
      })
    )
  })

  test('preserves the assistant item replaced by a reclassified process block', () => {
    const onBlockCreated = vi.fn()

    emitResponseApiEvent(
      { onBlockCreated },
      'response.block.created',
      {
        taskId: 'task-1',
        subtaskId: '2',
        data: {
          replacesItemId: 'msg-progress',
          block: {
            id: 'msg-progress',
            type: 'text',
            content: 'I will inspect.',
            status: 'done',
            timestamp: 1770000000000,
          },
        },
      },
      createResponseApiStreamState()
    )

    expect(onBlockCreated).toHaveBeenCalledWith({
      taskId: 'task-1',
      subtaskId: '2',
      replacesItemId: 'msg-progress',
      block: expect.objectContaining({
        id: 'msg-progress',
        type: 'text',
        content: 'I will inspect.',
      }),
    })
  })
})
