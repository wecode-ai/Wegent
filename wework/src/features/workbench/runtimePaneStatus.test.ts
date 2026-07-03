import { describe, expect, test } from 'vitest'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { deriveRuntimePaneStatus, getRuntimePaneTaskExecution } from './runtimePaneStatus'

const runtimeAddress: RuntimeTaskAddress = {
  deviceId: 'device-1',
  workspacePath: '/workspace/project',
  localTaskId: 'runtime-a',
}

function assistantMessage(status: WorkbenchMessage['status']): WorkbenchMessage {
  return {
    id: 'runtime-a:message:1',
    role: 'assistant',
    content: 'working',
    status,
    createdAt: '2026-07-02T00:00:00.000Z',
    turnId: 1,
    blocks: [
      {
        id: 'tool-1',
        turnId: 1,
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
        localTasks: [
          {
            localTaskId: 'runtime-a',
            workspacePath: '/workspace/project',
            title: 'Runtime A',
            runtime: 'codex',
            running,
            status,
          },
        ],
      },
    ],
    totalLocalTasks: 1,
  }
}

describe('runtime pane status', () => {
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
})
