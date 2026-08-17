import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { RuntimeTaskMachine } from './runtimeTaskLifecycle/RuntimeTaskMachine'
import { deriveRuntimePaneStatus } from './runtimePaneStatus'

const runtimeAddress: RuntimeTaskAddress = {
  deviceId: 'device-1',
  workspacePath: '/workspace/project',
  taskId: 'runtime-a',
}

function task(overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return {
    taskId: runtimeAddress.taskId,
    workspacePath: runtimeAddress.workspacePath ?? '',
    title: 'Runtime A',
    runtime: 'codex',
    running: false,
    continuable: true,
    ...overrides,
  }
}

function assistantMessage(status: WorkbenchMessage['status']): WorkbenchMessage {
  return {
    id: 'runtime-a:message:1',
    role: 'assistant',
    content: 'working',
    status,
    createdAt: '2026-07-02T00:00:00.000Z',
    subtaskId: 1,
  }
}

function statusFor(machine: RuntimeTaskMachine, messages: WorkbenchMessage[] = []) {
  return deriveRuntimePaneStatus({
    messages,
    currentRuntimeTask: runtimeAddress,
    lifecycle: machine.getSnapshot(),
  })
}

describe('runtime pane status from task lifecycle machine', () => {
  test('uses the machine execution snapshot as the only busy source', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: true }),
    })

    const status = statusFor(machine)

    expect(status.taskExecution.running).toBe(true)
    expect(status.isBusy).toBe(true)
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
  })

  test('shows submitting immediately from the optimistic machine event', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'send_requested' })

    const status = statusFor(machine)

    expect(status.isSubmitting).toBe(true)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.taskExecution.running).toBe(true)
  })

  test('shows waiting after executor accepts the send', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'send_requested' })
    machine.dispatch({ type: 'send_accepted' })

    const status = statusFor(machine, [assistantMessage('failed')])

    expect(status.isAwaitingAssistant).toBe(true)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.isBusy).toBe(true)
  })

  test('shows streaming only when the machine owns an active turn', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({ type: 'turn_started' })

    const status = statusFor(machine, [assistantMessage('streaming')])

    expect(status.isAssistantStreaming).toBe(true)
    expect(status.activeAssistantMessage?.id).toBe('runtime-a:message:1')
    expect(status.isWaitingForAssistantIndicator).toBe(false)
  })

  test('ignores a stale streaming message after the machine settles the turn', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: false, status: 'done' }),
    })

    const status = statusFor(machine, [assistantMessage('streaming')])

    expect(status.activeAssistantMessage).toBeNull()
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isBusy).toBe(false)
  })

  test('keeps an active Goal visibly running between turns', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: true, status: 'active', goalStatus: 'active' }),
    })
    machine.dispatch({ type: 'turn_started' })
    machine.dispatch({ type: 'turn_settled' })

    const status = statusFor(machine, [assistantMessage('done')])

    expect(status.taskExecution.running).toBe(true)
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.isBusy).toBe(true)
    expect(status.canSendQueuedMessage).toBe(false)
  })

  test('does not infer running from a persisted active Goal after restart', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: false, status: 'active', goalStatus: 'active' }),
    })

    const status = statusFor(machine, [assistantMessage('done')])

    expect(status.taskExecution.running).toBe(false)
    expect(status.isWaitingForAssistantIndicator).toBe(false)
    expect(status.isBusy).toBe(false)
    expect(status.canSendQueuedMessage).toBe(true)
  })

  test('keeps continuation capability separate from execution', () => {
    const machine = new RuntimeTaskMachine(runtimeAddress)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeAddress,
      task: task({ running: false, continuable: false, status: 'done' }),
    })

    const status = statusFor(machine)

    expect(status.taskExecution.running).toBe(false)
    expect(status.taskExecution.continuable).toBe(false)
    expect(status.canSendQueuedMessage).toBe(false)
  })
})
