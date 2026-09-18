import { describe, expect, it } from 'vitest'
import type { ProjectChatMessage } from '@wegent/chat-core'
import type { CollaborationExecution } from '../types'
import { executionRuntimeAddress, messageRuntimeExecutionTarget } from './runtimeExecutionTarget'

const message: ProjectChatMessage = {
  messageId: 'message',
  projectId: 'project',
  taskId: 'issue',
  sequenceNumber: 1,
  sender: { type: 'agent', id: 'bot', name: 'Codex' },
  type: 'text',
  content: 'Done',
  metadata: { run_status: 'succeeded', run_id: 'run', model: 'model' },
  status: 'completed',
  createdAt: '2026-09-17T00:00:00Z',
  updatedAt: '2026-09-17T00:00:00Z',
}
const execution = {
  id: 42,
  task_title: 'pwd',
  display_state: 'running',
  runtime_device_id: 'record-device',
  runtime_task_id: 'record-task',
} as CollaborationExecution

describe('execution conversation identity', () => {
  it('opens directly from the message address without an execution record', () => {
    const address = { deviceId: 'actual-device', taskId: 'actual-task' }
    expect(messageRuntimeExecutionTarget({ ...message, runtimeAddress: address })).toMatchObject({
      address,
      senderName: 'Codex',
      runId: 'run',
      modelName: 'model',
      runStatus: 'completed',
    })
  })
  it('uses the message address and terminal status over stale execution metadata', () => {
    const address = { deviceId: 'new-device', taskId: 'new-task' }
    expect(
      messageRuntimeExecutionTarget({ ...message, runtimeAddress: address }, execution)
    ).toMatchObject({
      address,
      taskTitle: 'pwd',
      runStatus: 'completed',
    })
  })
  it('can use a bound execution but never treats its database ID as a runtime task ID', () => {
    expect(messageRuntimeExecutionTarget(message, execution)?.address).toEqual({
      deviceId: 'record-device',
      taskId: 'record-task',
    })
    const unbound = { ...execution, runtime_task_id: null }
    expect(executionRuntimeAddress(unbound)).toBeNull()
    expect(messageRuntimeExecutionTarget(message, unbound)).toBeNull()
    expect(messageRuntimeExecutionTarget(message)).toBeNull()
  })
})
