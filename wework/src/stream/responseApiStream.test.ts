import { describe, expect, test, vi } from 'vitest'
import { createResponseApiStreamState, emitResponseApiEvent } from './responseApiStream'

describe('emitResponseApiEvent', () => {
  test('does not treat full output snapshots as text deltas', () => {
    const onChatChunk = vi.fn()

    emitResponseApiEvent(
      { onChatChunk },
      'response.output_text.delta',
      {
        task_id: 1,
        subtask_id: 2,
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
        task_id: 1,
        subtask_id: 2,
        device_id: 'device-1',
        local_task_id: 'local-1',
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
      task_id: 1,
      subtask_id: 2,
      device_id: 'device-1',
      local_task_id: 'local-1',
      agent_path: '/root/worker',
      agent_name: 'worker',
      agent_thread_id: 'thread-1',
      kind: 'started',
      status: 'running',
      occurred_at_ms: 12345,
    })
  })
})
