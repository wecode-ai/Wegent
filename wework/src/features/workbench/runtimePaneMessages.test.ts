import { describe, expect, test } from 'vitest'
import { createRuntimeTaskStreamHandlers } from './runtimePaneMessages'
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
})
