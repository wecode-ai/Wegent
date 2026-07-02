import { describe, expect, test } from 'vitest'
import {
  createRuntimeTaskStreamHandlers,
  runtimeMessagesToWorkbenchMessages,
} from './runtimePaneMessages'
import type { RuntimePaneMessageAction } from './runtimePaneMessages'
import type { RuntimeTaskAddress } from '@/types/api'

describe('createRuntimeTaskStreamHandlers', () => {
  test('passes context compaction through regular block created actions', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      localTaskId: 'local-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onBlockCreated?.({
      task_id: 1,
      subtask_id: 9,
      local_task_id: 'local-task-1',
      device_id: 'device-1',
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
      block: {
        id: 'ctx-1',
        type: 'tool',
        toolName: 'context_compaction',
        status: 'done',
      },
    })
  })

  test('preserves request user input render payload on block created events', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      localTaskId: 'local-task-1',
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
      task_id: 1,
      subtask_id: 9,
      local_task_id: 'local-task-1',
      device_id: 'device-1',
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
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      localTaskId: 'local-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatDone?.({
      task_id: 1,
      subtask_id: 9,
      local_task_id: 'local-task-1',
      device_id: 'device-1',
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
      turnId: 9,
      content: '当前分支比 origin/main ahead 1，可以直接 push。',
    })
  })

  test('settles runtime streams without forwarding empty final content', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      localTaskId: 'local-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatDone?.({
      task_id: 1,
      subtask_id: 9,
      offset: 0,
      local_task_id: 'local-task-1',
      device_id: 'device-1',
      result: {
        value: '',
      },
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_done',
      turnId: 9,
    })
    expect(
      (actions[0] as Extract<RuntimePaneMessageAction, { type: 'assistant_done' }>).content
    ).toBeUndefined()
  })

  test('treats interrupted runtime errors as cancellation events', () => {
    const address: RuntimeTaskAddress = {
      deviceId: 'device-1',
      localTaskId: 'local-task-1',
    }
    const actions: RuntimePaneMessageAction[] = []
    const handlers = createRuntimeTaskStreamHandlers(address, {
      onMessageAction: action => actions.push(action),
    })

    handlers.onChatError?.({
      task_id: 1,
      subtask_id: 9,
      local_task_id: 'local-task-1',
      device_id: 'device-1',
      error: 'interrupted',
    })

    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: 'assistant_cancelled',
      turnId: 9,
    })
  })
})

describe('runtimeMessagesToWorkbenchMessages', () => {
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
