import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createRuntimeTaskStreamHandlers,
  runtimeMessagesToWorkbenchMessages,
  runtimeTranscriptTurnsToConversationTurns,
} from './runtimePaneMessages'
import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { RuntimeTaskAddress } from '@/types/api'

describe('runtime transcript status', () => {
  test('preserves the first transcript message index for turn ordering', () => {
    const [turn] = runtimeTranscriptTurnsToConversationTurns([
      {
        id: 'turn-1',
        messageIndex: 42,
        items: [],
        status: 'done',
      },
    ])

    expect(turn.runtimeMessageIndex).toBe(42)
  })

  test('keeps valid canonical items when a transcript turn contains a malformed item', () => {
    const [turn] = runtimeTranscriptTurnsToConversationTurns([
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: '',
            type: 'assistant_text',
            content: 'invalid',
          },
          {
            id: 'assistant-item-1',
            type: 'assistant_text',
            content: 'valid',
          },
        ],
      },
    ])

    expect(turn.items).toEqual([
      expect.objectContaining({
        id: 'assistant-item-1',
        type: 'assistant_text',
        content: 'valid',
      }),
    ])
  })

  test('uses the turn timestamp for restored blocks without their own timestamp', () => {
    const [turn] = runtimeTranscriptTurnsToConversationTurns([
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'user-item-1',
            type: 'user_message',
            message: {
              id: 'user-message-1',
              role: 'user',
              content: 'run it',
              createdAt: '2026-07-30T08:00:00.000Z',
            },
          },
          {
            id: 'block-item-1',
            type: 'block',
            block: {
              id: 'tool-1',
              type: 'tool',
              toolName: 'exec_command',
              status: 'done',
            },
          },
        ],
      },
    ])

    expect(turn.items).toContainEqual(
      expect.objectContaining({
        id: 'block-item-1',
        type: 'block',
        block: expect.objectContaining({
          createdAt: Date.parse('2026-07-30T08:00:00.000Z'),
        }),
      })
    )
  })

  test('restores tool lifecycle timing from the runtime transcript', () => {
    const [turn] = runtimeTranscriptTurnsToConversationTurns([
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'block-item-1',
            type: 'block',
            block: {
              id: 'tool-1',
              type: 'tool',
              toolName: 'exec_command',
              status: 'done',
              timestamp: 1_780_000_001_250,
              completedAt: 1_780_000_004_750,
            },
          },
          {
            id: 'block-item-2',
            type: 'block',
            block: {
              id: 'tool-2',
              type: 'tool',
              toolName: 'exec_command',
              status: 'done',
              timestamp: 1_780_000_010_000,
              durationMs: 2_500,
            },
          },
        ],
      },
    ])

    expect(turn.items).toEqual([
      expect.objectContaining({
        id: 'block-item-1',
        type: 'block',
        block: expect.objectContaining({
          createdAt: 1_780_000_001_250,
          completedAt: 1_780_000_004_750,
        }),
      }),
      expect.objectContaining({
        id: 'block-item-2',
        type: 'block',
        block: expect.objectContaining({
          createdAt: 1_780_000_010_000,
          completedAt: 1_780_000_012_500,
        }),
      }),
    ])
  })

  test('does not infer streaming from an active conversation status', () => {
    const [message] = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-history',
        role: 'assistant',
        content: 'Finished answer',
        status: 'active',
        subtaskId: 'turn-1',
      },
    ])

    expect(message.status).toBe('done')
  })

  test('restores Codex failure details from the runtime transcript', () => {
    const [message] = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-failed',
        role: 'assistant',
        content: '',
        status: 'failed',
        subtaskId: 'turn-1',
        error: 'The upstream response ended before a terminal event.',
        errorType: 'response.failed',
      },
    ])

    expect(message).toMatchObject({
      status: 'failed',
      error: 'The upstream response ended before a terminal event.',
      errorType: 'response.failed',
    })
  })
})

describe('createRuntimeTaskStreamHandlers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('uses task and subtask identity for runtime assistant messages', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      content: 'partial',
      offset: 0,
      result: {},
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_chunk',
      subtaskId: 'subtask-9',
      content: 'partial',
      offset: 0,
    })
    expect('messageId' in actions[0]).toBe(false)
  })

  test('forwards an active task title change without refreshing runtime work', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const onRuntimeTaskTitleUpdated = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: vi.fn(),
      onRuntimeTaskTitleUpdated,
    })

    handlers.onRuntimeTaskTitleUpdated?.({
      taskId: 'runtime-task-1',
      subtaskId: 'friendly-title-turn',
      deviceId: 'device-1',
      title: '测试标题生成功能',
    })

    expect(onRuntimeTaskTitleUpdated).toHaveBeenCalledWith({
      taskId: 'runtime-task-1',
      subtaskId: 'friendly-title-turn',
      deviceId: 'device-1',
      title: '测试标题生成功能',
    })
  })

  test('inserts an idle supervisor correction before its assistant turn starts', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatStart?.({
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
      subtaskId: 'turn-1',
      clientUserMessageId: 'supervisor-correction-1',
      runtimeGeneratedUserMessage: {
        id: 'supervisor-correction-1',
        message: 'Return to scope.',
        createdAt: 1_700_000_000_000,
        source: { source: 'supervisor' },
      },
    })

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'user_added',
        message: expect.objectContaining({
          id: 'supervisor-correction-1',
          content: 'Return to scope.',
        }),
      }),
      expect.objectContaining({
        type: 'assistant_started',
        subtaskId: 'turn-1',
        clientUserMessageId: 'supervisor-correction-1',
      }),
    ])
  })

  test('preserves completed item snapshot semantics', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      itemId: 'message-1',
      content: 'Complete answer',
      contentMode: 'snapshot',
      result: {},
    })

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'assistant_chunk',
        subtaskId: 'turn-1',
        itemId: 'message-1',
        content: 'Complete answer',
        contentMode: 'snapshot',
      }),
    ])
  })

  test('forwards the client user message id when the runtime turn starts', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatStart?.({
      taskId: 'runtime-task-1',
      subtaskId: 'codex-turn-9',
      deviceId: 'device-1',
      clientUserMessageId: 'client-user-1',
    })

    expect(actions).toEqual([
      {
        type: 'assistant_started',
        taskId: 'runtime-task-1',
        subtaskId: 'codex-turn-9',
        clientUserMessageId: 'client-user-1',
        shellType: undefined,
      },
    ])
  })

  test('commits the turn terminal action before settling the task lifecycle', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const calls: string[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => calls.push(action.type),
      onAssistantSettled: () => calls.push('lifecycle_settled'),
    })

    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'codex-turn-9',
      deviceId: 'device-1',
      result: {},
    })

    expect(calls).toEqual(['assistant_done', 'lifecycle_settled'])
  })

  test('settles a provider-renamed terminal event against its provisional start', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const onAssistantSettled = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: vi.fn(),
      onAssistantSettled,
    })

    handlers.onChatStart?.({
      taskId: 'runtime-task-1',
      subtaskId: 'provisional-turn',
      deviceId: 'device-1',
    })
    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'canonical-turn',
      deviceId: 'device-1',
      result: {},
    })

    expect(onAssistantSettled).toHaveBeenCalledWith('provisional-turn', 'succeeded')
  })

  test('settles renamed overlapping turns in their start order', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const onAssistantSettled = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: vi.fn(),
      onAssistantSettled,
    })

    for (const subtaskId of ['provisional-turn-1', 'provisional-turn-2']) {
      handlers.onChatStart?.({
        taskId: 'runtime-task-1',
        subtaskId,
        deviceId: 'device-1',
      })
    }
    for (const subtaskId of ['canonical-turn-1', 'canonical-turn-2']) {
      handlers.onChatDone?.({
        taskId: 'runtime-task-1',
        subtaskId,
        deviceId: 'device-1',
        result: {},
      })
    }

    expect(onAssistantSettled.mock.calls).toEqual([
      ['provisional-turn-1', 'succeeded'],
      ['provisional-turn-2', 'succeeded'],
    ])
  })

  test('does not settle a newer turn from a repeated old terminal event', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const onAssistantSettled = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: vi.fn(),
      onAssistantSettled,
    })

    handlers.onChatStart?.({
      taskId: 'runtime-task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
    })
    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      result: {},
    })
    handlers.onChatStart?.({
      taskId: 'runtime-task-1',
      subtaskId: 'turn-2',
      deviceId: 'device-1',
    })
    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      result: {},
    })

    expect(onAssistantSettled).toHaveBeenCalledTimes(1)
    expect(onAssistantSettled).toHaveBeenCalledWith('turn-1', 'succeeded')
  })

  test('maps a Codex failure to an identified canonical error item action', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatError?.({
      taskId: 'runtime-task-1',
      subtaskId: 'codex-turn-9',
      deviceId: 'device-1',
      shellType: 'codex',
      error: 'Context window exceeded',
      type: 'response.failed',
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_error',
      subtaskId: 'codex-turn-9',
      error: 'Context window exceeded',
      errorType: 'response.failed',
    })
  })

  test('forwards structured task-plan updates for the active runtime task', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const onRuntimePlanUpdated = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: vi.fn(),
      onRuntimePlanUpdated,
    })

    handlers.onRuntimePlanUpdated?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: 'Implement the requested change.',
      plan: [{ step: 'Implement', status: 'inProgress' }],
    })

    expect(onRuntimePlanUpdated).toHaveBeenCalledWith({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: 'Implement the requested change.',
      plan: [{ step: 'Implement', status: 'inProgress' }],
    })
  })

  test('streams camelCase reasoning chunks into assistant messages', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      content: '',
      offset: 0,
      result: { reasoningChunk: '正在分析' },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_chunk',
      subtaskId: 'subtask-9',
      content: '',
      reasoningChunk: '正在分析',
    })
    expect(warn).not.toHaveBeenCalled()
  })

  test('warns instead of silently dropping empty runtime chunks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      content: '',
      offset: 0,
      result: {},
    })

    expect(actions).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Dropped empty runtime stream chunk',
      expect.objectContaining({
        event: 'chat:chunk',
        taskId: 'runtime-task-1',
        deviceId: 'device-1',
        subtaskId: 'subtask-9',
        reason: 'empty_chunk',
      })
    )
  })

  test('updates context usage from task-scoped chunks without subtask identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onContextUsageUpdated = vi.fn()
    const contextUsage = {
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
    }
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onContextUsageUpdated,
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      deviceId: 'device-1',
      content: '',
      result: { contextUsage },
    })

    expect(actions).toHaveLength(0)
    expect(onContextUsageUpdated).toHaveBeenCalledWith(contextUsage)
    expect(warn).not.toHaveBeenCalled()
  })

  test('warns when snake case reasoning chunks reach the pane layer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      content: '',
      offset: 0,
      result: { reasoning_chunk: '正在分析' },
    })

    expect(actions).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Dropped empty runtime stream chunk',
      expect.objectContaining({
        event: 'chat:chunk',
        taskId: 'runtime-task-1',
        deviceId: 'device-1',
        subtaskId: 'subtask-9',
        resultKeys: ['reasoning_chunk'],
      })
    )
  })

  test('passes context compaction through regular block created actions without refreshing work', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantSettled = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantSettled,
    })

    handlers.onBlockCreated?.({
      taskId: 'runtime-task-1',
      subtaskId: 'runtime-task-1-context-compact',
      deviceId: 'device-1',
      block: {
        id: 'ctx-1',
        type: 'tool',
        tool_name: 'context_compaction',
        status: 'done',
        timestamp: 1770000000000,
      },
    })

    expect(actions).toHaveLength(2)
    expect(actions[0]).toMatchObject({
      type: 'block_created',
      block: {
        id: 'ctx-1',
        type: 'tool',
        toolName: 'context_compaction',
        status: 'done',
      },
    })
    expect(actions[1]).toMatchObject({
      type: 'assistant_done',
      subtaskId: 'runtime-task-1-context-compact',
    })
    expect(onAssistantSettled).toHaveBeenCalledTimes(1)
  })

  test('passes reclassified assistant text identity to the conversation reducer', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onBlockCreated?.({
      taskId: 'runtime-task-1',
      subtaskId: 'turn-1',
      deviceId: 'device-1',
      replacesItemId: 'msg-progress',
      block: {
        id: 'msg-progress',
        type: 'text',
        content: 'I will inspect.',
        status: 'done',
        timestamp: 1770000000000,
      },
    })

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'block_created',
        subtaskId: 'turn-1',
        replaceAssistantTextItemId: 'msg-progress',
        block: expect.objectContaining({
          id: 'msg-progress',
          type: 'text',
          content: 'I will inspect.',
        }),
      }),
    ])
  })

  test('does not finish an active assistant turn for automatic context compaction', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantSettled = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantSettled,
    })

    handlers.onBlockCreated?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      block: {
        id: 'ctx-1',
        type: 'tool',
        tool_name: 'context_compaction',
        status: 'done',
        timestamp: 1770000000000,
      },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'block_created',
      subtaskId: 'subtask-9',
      block: {
        id: 'ctx-1',
        type: 'tool',
        toolName: 'context_compaction',
        status: 'done',
      },
    })
    expect(onAssistantSettled).not.toHaveBeenCalled()
  })

  test('preserves request user input render payload on block created events', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })
    const renderPayload = {
      kind: 'request_user_input',
      request_id: 42,
      questions: [
        {
          id: 'goal',
          question: 'What should I prioritize?',
          options: [{ label: 'Work goal', description: 'Focus the next turn' }],
        },
      ],
    }

    handlers.onBlockCreated?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      block: {
        id: 'request-42',
        type: 'tool',
        tool_name: 'request_user_input',
        status: 'pending',
        render_payload: renderPayload,
      },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'block_created',
      block: {
        id: 'request-42',
        type: 'tool',
        toolName: 'request_user_input',
        renderPayload,
      },
    })
  })

  test('strips Codex UI directives from completed assistant content', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      offset: 0,
      result: {
        turnId: 'turn-9',
        value: [
          '当前分支比 origin/main ahead 1，可以直接 push。',
          '',
          '::git-stage{cwd="/workspace/project"} ::git-commit{cwd="/workspace/project"}',
        ].join('\n'),
      },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_done',
      subtaskId: 'subtask-9',
      turnId: 'turn-9',
    })
    expect(info).toHaveBeenCalledWith(
      '[Wework] Runtime terminal event accepted',
      expect.objectContaining({
        event: 'chat:done',
        payloadTaskId: 'runtime-task-1',
        payloadSubtaskId: 'subtask-9',
      })
    )
  })

  test('warns when a terminal event does not match the subscribed runtime task', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(
      { deviceId: 'device-1', taskId: 'runtime-task-1' },
      { onMessageAction: action => actions.push(action) }
    )

    handlers.onChatDone?.({
      taskId: 'runtime-task-2',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      result: { value: 'complete' },
    })

    expect(actions).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Dropped mismatched runtime terminal event',
      expect.objectContaining({
        event: 'chat:done',
        payloadTaskId: 'runtime-task-2',
        payloadSubtaskId: 'subtask-9',
      })
    )
  })

  test('settles runtime streams without forwarding empty final content', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      offset: 0,
      deviceId: 'device-1',
      result: {
        value: '',
      },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_done',
      subtaskId: 'subtask-9',
    })
    expect(
      (actions[0] as Extract<RuntimePaneMessageAction, { type: 'assistant_done' }>).content
    ).toBeUndefined()
  })

  test('uses completed runtime content as the authoritative final answer', () => {
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(
      { deviceId: 'device-1', taskId: 'runtime-task-1' },
      { onMessageAction: action => actions.push(action) }
    )

    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      result: {
        itemId: 'assistant-item-9',
        value: '最终回答。',
      },
    })

    expect(actions).toEqual([
      expect.objectContaining({
        type: 'assistant_done',
        subtaskId: 'subtask-9',
        itemId: 'assistant-item-9',
        content: '最终回答。',
      }),
    ])
  })

  test('builds the completed turn file changes summary from streamed blocks', () => {
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(
      { deviceId: 'device-1', taskId: 'runtime-task-1' },
      { onMessageAction: action => actions.push(action) }
    )
    const summary = {
      version: 1 as const,
      status: 'active' as const,
      artifact_id: 'artifact-1',
      device_id: 'device-1',
      workspace_path: '/workspace/project',
      file_count: 1,
      additions: 2,
      deletions: 1,
      files: [
        {
          path: 'src/main.ts',
          change_type: 'modified' as const,
          additions: 2,
          deletions: 1,
          binary: false,
        },
      ],
    }

    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      result: {
        value: 'Done',
        blocks: [
          {
            id: 'file-changes-1',
            type: 'file_changes',
            status: 'done',
            fileChanges: summary,
          },
        ],
      },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_done',
      fileChanges: summary,
    })
  })

  test('keeps file change blocks until a later completion event', () => {
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(
      { deviceId: 'device-1', taskId: 'runtime-task-1' },
      { onMessageAction: action => actions.push(action) }
    )
    const fileChanges = {
      version: 1 as const,
      status: 'active' as const,
      artifact_id: 'artifact-1',
      device_id: 'device-1',
      workspace_path: '/workspace/project',
      file_count: 1,
      additions: 1,
      deletions: 0,
      files: [
        {
          path: 'qa.txt',
          change_type: 'created' as const,
          additions: 1,
          deletions: 0,
          binary: false,
        },
      ],
    }

    handlers.onBlockCreated?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      block: {
        id: 'file-changes-1',
        type: 'file_changes',
        status: 'streaming',
        file_changes: fileChanges,
      },
    })
    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      result: { value: 'Done' },
    })

    expect(actions[1]).toMatchObject({
      type: 'assistant_done',
      fileChanges,
    })
  })

  test('restores historical blocks that use a numeric subtask identity', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-history',
        role: 'assistant',
        content: '已完成',
        subtaskId: 901,
        blocks: [
          {
            id: 'tool-history',
            type: 'tool',
            tool_name: 'exec_command',
            tool_input: { cmd: 'pwd' },
            status: 'done',
          },
          {
            id: 'file-history',
            type: 'file_changes',
            status: 'done',
            file_changes: {
              version: 1,
              status: 'active',
              artifact_id: 'artifact-history',
              device_id: 'device-1',
              workspace_path: '/workspace/project',
              file_count: 1,
              additions: 1,
              deletions: 0,
              files: [
                {
                  path: 'history.txt',
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
    ])

    expect(messages[0]).toMatchObject({
      subtaskId: '901',
      blocks: [
        { type: 'tool', toolName: 'exec_command' },
        { type: 'file_changes', fileChanges: { files: [{ path: 'history.txt' }] } },
      ],
    })
  })

  test('treats interrupted runtime errors as cancellation events', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatError?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      error: 'interrupted',
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_cancelled',
      subtaskId: 'subtask-9',
    })
  })

  test('warns before dropping runtime stream message events without task identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      deviceId: 'device-1',
      content: 'partial',
      offset: 0,
      result: {},
    } as Parameters<NonNullable<typeof handlers.onChatChunk>>[0])

    expect(actions).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Dropped runtime stream event without task identity',
      expect.objectContaining({
        event: 'chat:chunk',
        taskId: 'runtime-task-1',
        deviceId: 'device-1',
        subtaskId: undefined,
        hasContent: true,
      })
    )
  })

  test('maps zero subtask ids to subtask ids for runtime block events', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onBlockUpdated?.({
      taskId: 'runtime-task-1',
      subtaskId: '0',
      deviceId: 'device-1',
      blockId: 'text-local-task-1-0-1',
      content: 'partial',
      status: 'done',
      completedAt: 1_780_000_004_750,
      durationMs: 3_500,
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'block_updated',
      subtaskId: '0',
      blockId: 'text-local-task-1-0-1',
      updates: {
        content: 'partial',
        status: 'done',
        completedAt: 1_780_000_004_750,
        durationMs: 3_500,
      },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  test('emits onAssistantFirstToken once per turn on the first content chunk', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantFirstToken = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantFirstToken,
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      content: 'first',
      offset: 0,
      result: {},
    })
    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      content: 'second',
      offset: 5,
      result: {},
    })

    expect(onAssistantFirstToken).toHaveBeenCalledTimes(1)
    expect(onAssistantFirstToken).toHaveBeenCalledWith('subtask-9')
  })

  test('emits onAssistantFirstToken for a leading reasoning chunk', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantFirstToken = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantFirstToken,
    })

    handlers.onChatChunk?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      content: '',
      offset: 0,
      result: { reasoningChunk: 'thinking...' },
    })

    expect(onAssistantFirstToken).toHaveBeenCalledWith('subtask-9')
  })

  test('reports the response body size from the final assistant content', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantResponseSize = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantResponseSize,
    })

    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      result: { value: 'hello' },
    })

    expect(onAssistantResponseSize).toHaveBeenCalledWith('subtask-9', 5)
  })

  test('does not report response body size when the turn has no final content', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantResponseSize = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantResponseSize,
    })

    handlers.onChatDone?.({
      taskId: 'runtime-task-1',
      subtaskId: 'subtask-9',
      deviceId: 'device-1',
      result: { value: '' },
    })

    expect(onAssistantResponseSize).not.toHaveBeenCalled()
  })
})

describe('runtimeMessagesToWorkbenchMessages', () => {
  test('uses the client message id to reconcile a persisted user message', () => {
    const [message] = runtimeMessagesToWorkbenchMessages([
      {
        id: 'codex-user-item-1',
        clientUserMessageId: 'runtime-local-pane-1',
        role: 'user',
        content: 'hello',
        status: 'done',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    ])

    expect(message).toMatchObject({
      id: 'runtime-local-pane-1',
      role: 'user',
      content: 'hello',
    })
  })

  test('combines provider content with non-overlapping Wework presentation references', () => {
    const [message] = runtimeMessagesToWorkbenchMessages([
      {
        id: 'codex-user-item-1',
        clientUserMessageId: 'runtime-local-pane-1',
        role: 'user',
        content: '请用 $plugin:skill explain the sidebar',
        presentationReferences: [
          {
            start: 3,
            end: 16,
            href: '/tmp/plugin/skill/SKILL.md',
          },
        ],
        status: 'done',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    ])

    expect(message).toMatchObject({
      id: 'runtime-local-pane-1',
      role: 'user',
      content: '请用 [$plugin:skill](/tmp/plugin/skill/SKILL.md) explain the sidebar',
    })
  })

  test('combines provider content with a Wework plugin presentation reference', () => {
    const [message] = runtimeMessagesToWorkbenchMessages([
      {
        id: 'codex-user-item-1',
        clientUserMessageId: 'runtime-local-pane-1',
        role: 'user',
        content: '@OpenAI Developers Create an API key',
        presentationReferences: [
          {
            start: 0,
            end: 18,
            href: 'plugin://openai-developers@openai-curated',
          },
        ],
        status: 'done',
        createdAt: '2026-07-17T00:00:00.000Z',
      },
    ])

    expect(message).toMatchObject({
      id: 'runtime-local-pane-1',
      role: 'user',
      content: '[@OpenAI Developers](plugin://openai-developers@openai-curated) Create an API key',
    })
  })
})

describe('runtimeMessagesToWorkbenchMessages', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('uses explicit camelCase subtask identity for restored runtime blocks', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-runtime',
        role: 'assistant',
        content: '',
        subtaskId: '10000110751749',
        status: 'streaming',
        blocks: [
          {
            id: 'text-1',
            type: 'text',
            content: 'streamed process text',
            status: 'done',
          },
        ],
      },
    ])

    expect(messages[0]).toMatchObject({
      subtaskId: '10000110751749',
      blocks: [
        {
          id: 'text-1',
          subtaskId: '10000110751749',
          type: 'text',
        },
      ],
    })
  })

  test('warns instead of creating fallback ids for restored runtime messages without subtask identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-runtime',
        role: 'assistant',
        content: '',
        status: 'streaming',
        blocks: [
          {
            id: 'text-1',
            type: 'text',
            content: 'streamed process text',
            status: 'done',
          },
        ],
      },
    ])

    expect(messages[0].subtaskId).toBeUndefined()
    expect(messages[0].blocks).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Runtime transcript message missing valid subtask identity',
      expect.objectContaining({
        messageId: 'assistant-runtime',
        status: 'streaming',
        blockCount: 1,
      })
    )
  })

  test('warns instead of creating fallback block ids for restored runtime blocks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-runtime',
        role: 'assistant',
        content: '',
        subtaskId: '10000110751749',
        status: 'streaming',
        blocks: [
          {
            type: 'text',
            content: 'streamed process text',
            status: 'done',
          },
        ],
      },
    ])

    expect(messages[0].blocks).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      '[Wework] Dropped runtime transcript block without block identity',
      expect.objectContaining({
        subtaskId: '10000110751749',
        blockType: 'text',
      })
    )
  })

  test('strips Codex UI directives from restored assistant transcript content', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [
          '完成了。',
          '',
          '```text',
          '::git-stage{cwd="/workspace/project"}',
          '```',
          '',
          '::git-commit{cwd="/workspace/project"}',
        ].join('\n'),
      },
    ])

    expect(messages[0].content).toBe(
      ['完成了。', '', '```text', '::git-stage{cwd="/workspace/project"}', '```'].join('\n')
    )
  })

  test('ignores invalid short-content truncation markers from a runtime transcript', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '这是一段完整的短回复。',
        content_truncated: true,
        content_original_chars: 11,
      },
    ])

    expect(messages[0]).toMatchObject({
      content: '这是一段完整的短回复。',
      contentTruncated: undefined,
      contentOriginalChars: undefined,
    })
  })

  test('ignores a short streamed suffix mislabeled as truncated content', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-k3',
        role: 'assistant',
        content: '保持两边同步。',
        content_truncated: true,
        content_original_chars: 26,
      },
    ])

    expect(messages[0]).toMatchObject({
      content: '保持两边同步。',
      contentTruncated: undefined,
      contentOriginalChars: undefined,
    })
  })

  test('keeps valid runtime content truncation markers so full content can be loaded', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '回复末尾预览',
        contentTruncated: true,
        contentOriginalChars: 200_001,
      },
    ])

    expect(messages[0]).toMatchObject({
      contentTruncated: true,
      contentOriginalChars: 200_001,
    })
  })

  test('keeps user-authored Codex directive text unchanged', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'user-1',
        role: 'user',
        content: '解释一下 ::git-stage{cwd="/workspace/project"} 是什么',
      },
    ])

    expect(messages[0].content).toBe('解释一下 ::git-stage{cwd="/workspace/project"} 是什么')
  })

  test('keeps assistant prose that mentions a Codex directive inline', () => {
    const messages = runtimeMessagesToWorkbenchMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '这类 ::git-stage{cwd="/workspace/project"} 指令会刷新 Git UI。',
      },
    ])

    expect(messages[0].content).toBe(
      '这类 ::git-stage{cwd="/workspace/project"} 指令会刷新 Git UI。'
    )
  })
})
