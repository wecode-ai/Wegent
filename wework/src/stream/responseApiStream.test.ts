import { describe, expect, test, vi } from 'vitest'
import { createResponseApiStreamState, emitResponseApiEvent } from './responseApiStream'

describe('emitResponseApiEvent', () => {
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
