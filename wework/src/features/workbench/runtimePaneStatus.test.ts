import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import {
  deriveRuntimePaneStatus,
  getRuntimePaneTaskExecution,
  hasRunningRuntimeTask,
} from './runtimePaneStatus'

const runtimeAddress: RuntimeTaskAddress = {
  deviceId: 'device-1',
  workspacePath: '/workspace/project',
  taskId: 'runtime-a',
}

function assistantMessage(status: WorkbenchMessage['status']): WorkbenchMessage {
  return {
    id: 'runtime-a:message:1',
    role: 'assistant',
    content: 'working',
    status,
    createdAt: '2026-07-02T00:00:00.000Z',
    subtaskId: 1,
    blocks: [
      {
        id: 'tool-1',
        subtaskId: 1,
        type: 'tool',
        toolName: 'bash',
        status: 'streaming',
        createdAt: 1770000000000,
      },
    ],
  }
}

function runtimeWork(running: boolean, status?: string | null): RuntimeWorkListResponse {
  return {
    projects: [],
    chats: [
      {
        deviceId: 'device-1',
        deviceName: 'Device',
        deviceStatus: 'online',
        workspacePath: '/workspace/project',
        available: true,
        tasks: [
          {
            taskId: 'runtime-a',
            workspacePath: '/workspace/project',
            title: 'Runtime A',
            runtime: 'codex',
            running,
            status,
          },
        ],
      },
    ],
    totalTasks: 1,
  }
}

describe('runtime pane status', () => {
  test('detects running tasks in standalone and project workspaces', () => {
    expect(hasRunningRuntimeTask(runtimeWork(false))).toBe(false)
    expect(hasRunningRuntimeTask(runtimeWork(true))).toBe(true)

    const projectWork = runtimeWork(false)
    projectWork.projects = [
      {
        project: { id: 1, name: 'Project' },
        deviceWorkspaces: [
          {
            ...projectWork.chats[0],
            tasks: [{ ...projectWork.chats[0].tasks[0], running: true }],
          },
        ],
      },
    ]
    projectWork.chats = []

    expect(hasRunningRuntimeTask(projectWork)).toBe(true)
  })

  test('treats a task without a running flag as unknown', () => {
    const runtimeWorkWithoutRunningState = runtimeWork(false)
    runtimeWorkWithoutRunningState.chats[0].tasks[0].running = undefined

    expect(getRuntimePaneTaskExecution(runtimeWorkWithoutRunningState, runtimeAddress)).toEqual({
      known: false,
      running: false,
      status: null,
    })
  })

  test('derives one busy state from send phase, streaming message, and task execution', () => {
    const taskExecution = getRuntimePaneTaskExecution(runtimeWork(true), runtimeAddress)
    const status = deriveRuntimePaneStatus({
      messages: [assistantMessage('streaming')],
      sendPhase: 'idle',
      currentRuntimeTask: runtimeAddress,
      taskExecution,
    })

    expect(status.isBusy).toBe(true)
    expect(status.isAssistantStreaming).toBe(true)
    expect(status.canSendQueuedMessage).toBe(false)
    expect(status.taskExecution.running).toBe(true)
  })

  test('treats submitting as the only composer submitting source', () => {
    const status = deriveRuntimePaneStatus({
      messages: [],
      sendPhase: 'submitting',
      currentRuntimeTask: runtimeAddress,
      taskExecution: { known: false, running: false, status: null },
    })

    expect(status.isSubmitting).toBe(true)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.isAssistantStreaming).toBe(false)
  })

  test('shows the waiting state while a failed assistant response is being retried', () => {
    const status = deriveRuntimePaneStatus({
      messages: [assistantMessage('failed')],
      sendPhase: 'awaiting_assistant',
      currentRuntimeTask: runtimeAddress,
      taskExecution: { known: true, running: false, status: 'failed' },
    })

    expect(status.isAwaitingAssistant).toBe(true)
    expect(status.isWaitingForAssistantIndicator).toBe(true)
    expect(status.isBusy).toBe(true)
  })

  test('does not let stale streaming messages keep a completed runtime task busy', () => {
    const taskExecution = getRuntimePaneTaskExecution(runtimeWork(false, 'done'), runtimeAddress)
    const status = deriveRuntimePaneStatus({
      messages: [assistantMessage('streaming')],
      sendPhase: 'idle',
      currentRuntimeTask: runtimeAddress,
      taskExecution,
    })

    expect(status.taskExecution).toEqual({ known: true, running: false, status: 'done' })
    expect(status.activeAssistantMessage).toBeNull()
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isBusy).toBe(false)
    expect(status.canSendQueuedMessage).toBe(true)
  })

  test('does not let a stale streaming transcript revive an idle non-terminal task', () => {
    const taskExecution = getRuntimePaneTaskExecution(runtimeWork(false, 'active'), runtimeAddress)
    const status = deriveRuntimePaneStatus({
      messages: [assistantMessage('streaming')],
      sendPhase: 'idle',
      currentRuntimeTask: runtimeAddress,
      taskExecution,
    })

    expect(status.taskExecution).toEqual({ known: true, running: false, status: 'active' })
    expect(status.activeAssistantMessage).toBeNull()
    expect(status.isAssistantStreaming).toBe(false)
    expect(status.isBusy).toBe(false)
    expect(status.canSendQueuedMessage).toBe(true)
  })
})
