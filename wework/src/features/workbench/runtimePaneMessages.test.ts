import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createRuntimeTaskStreamHandlers,
  runtimeMessagesToWorkbenchMessages,
} from './runtimePaneMessages'
import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { RuntimeTaskAddress } from '@/types/api'

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

  test('passes context compaction through regular block created actions', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantSettled = vi.fn()
    const onRefreshWorkLists = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantSettled,
      onRefreshWorkLists,
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
      content: '',
    })
    expect(onAssistantSettled).toHaveBeenCalledTimes(1)
    expect(onRefreshWorkLists).toHaveBeenCalledTimes(1)
  })

  test('does not finish an active assistant turn for automatic context compaction', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      taskId: 'runtime-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const onAssistantSettled = vi.fn()
    const onRefreshWorkLists = vi.fn()
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
      onAssistantSettled,
      onRefreshWorkLists,
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
    expect(onRefreshWorkLists).not.toHaveBeenCalled()
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
      content: '当前分支比 origin/main ahead 1，可以直接 push。',
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
      status: 'streaming',
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'block_updated',
      subtaskId: '0',
      blockId: 'text-local-task-1-0-1',
      updates: {
        content: 'partial',
        status: 'streaming',
      },
    })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('runtimeMessagesToWorkbenchMessages', () => {
  test('uses the client message id to reconcile a persisted user message', () => {
    const [message] = runtimeMessagesToWorkbenchMessages([
      {
        id: 'codex-user-item-1',
        clientMessageId: 'runtime-local-pane-1',
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
