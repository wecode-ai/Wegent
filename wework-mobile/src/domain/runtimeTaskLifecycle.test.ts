import { describe, expect, it } from 'vitest'

import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/runtime'
import {
  isRunningRuntimeEvent,
  isTerminalRuntimeEvent,
  RuntimeTaskLifecycleProjection,
  runtimeTaskKey,
} from './runtimeTaskLifecycle'

const address: RuntimeTaskAddress = {
  deviceId: 'device-1',
  taskId: 'task-1',
  workspacePath: '/work',
}

describe('RuntimeTaskLifecycleProjection', () => {
  it('projects a task as running immediately after send acceptance begins', () => {
    const lifecycle = new RuntimeTaskLifecycleProjection()

    lifecycle.sendRequested(address)

    expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(true)
  })

  it('settles a sent task only after the transcript confirms it is idle', () => {
    const lifecycle = new RuntimeTaskLifecycleProjection()
    lifecycle.sendRequested(address)
    const observation = lifecycle.transcriptRequested(address)

    expect(lifecycle.transcriptReceived(observation, false)).toBe(true)
    expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(false)
  })

  it('does not let an older transcript overwrite a newer send transition', () => {
    const lifecycle = new RuntimeTaskLifecycleProjection()
    const observation = lifecycle.transcriptRequested(address)
    lifecycle.sendRequested(address)

    expect(lifecycle.transcriptReceived(observation, false)).toBe(false)
    expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(true)
  })

  it('reopens a settled task when a global executor start event arrives', () => {
    const lifecycle = new RuntimeTaskLifecycleProjection()
    lifecycle.transcriptReceived(lifecycle.transcriptRequested(address), false)
    const staleObservation = lifecycle.transcriptRequested(address)

    expect(lifecycle.executorStarted(address)).toBe(true)
    expect(lifecycle.transcriptReceived(staleObservation, false)).toBe(false)
    expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(true)
  })

  it('does not roll back a transcript-confirmed terminal state when send completion races', () => {
    const lifecycle = new RuntimeTaskLifecycleProjection()
    const send = lifecycle.sendRequested(address)
    const observation = lifecycle.transcriptRequested(address)
    lifecycle.transcriptReceived(observation, false)

    expect(lifecycle.sendRejected(send)).toBe(false)
    expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(false)
  })

  it('keeps a terminal projection over a stale work response and releases it on agreement', () => {
    const lifecycle = new RuntimeTaskLifecycleProjection()
    lifecycle.transcriptReceived(lifecycle.transcriptRequested(address), false)

    expect(lifecycle.syncWork(workWithRunning(true))).toBe(false)
    expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(false)
    expect(lifecycle.syncWork(workWithRunning(false))).toBe(true)
    expect(lifecycle.snapshot().has(runtimeTaskKey(address))).toBe(false)
  })

  it('recognizes executor cancellation events as terminal', () => {
    expect(isTerminalRuntimeEvent('runtime.task.cancelled')).toBe(true)
    expect(isTerminalRuntimeEvent('runtime.tasks.cancelled')).toBe(true)
    expect(isTerminalRuntimeEvent('response.in_progress')).toBe(false)
  })

  it('recognizes native task lifecycle start events as running', () => {
    expect(isRunningRuntimeEvent('runtime.task.started')).toBe(true)
    expect(isRunningRuntimeEvent('runtime.task.status')).toBe(true)
  })
})

function workWithRunning(running: boolean): RuntimeWorkListResponse {
  return {
    totalTasks: 1,
    projects: [
      {
        project: { key: 'project-1', name: 'Project' },
        deviceWorkspaces: [
          {
            deviceId: address.deviceId,
            deviceName: 'Cloud Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/work',
            tasks: [
              {
                taskId: address.taskId,
                title: 'Task',
                runtime: 'codex',
                workspacePath: '/work',
                running,
              },
            ],
          },
        ],
      },
    ],
    chats: [],
  }
}

it('uses native execution revisions across completion, stale events, and executor replacement', () => {
  const lifecycle = new RuntimeTaskLifecycleProjection()
  const address = { deviceId: 'device', taskId: 'task' }
  const state = {
    revision: '2',
    epoch: 'first',
    phase: 'running' as const,
    turnId: 'turn',
    latestTurnId: 'turn',
    outcome: null,
  }
  expect(lifecycle.executionReceived(address, state)).toBe(true)
  expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(true)
  const read = lifecycle.transcriptRequested(address)
  expect(
    lifecycle.executionReceived(address, {
      ...state,
      revision: '3',
      phase: 'idle',
      turnId: null,
      outcome: 'succeeded',
    })
  ).toBe(true)
  expect(lifecycle.executionReceived(address, state)).toBe(false)
  expect(lifecycle.executorStarted(address)).toBe(false)
  expect(lifecycle.transcriptReceived(read, true)).toBe(false)
  expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(false)
  lifecycle.executorReplaced(address)
  expect(lifecycle.executionReceived(address, { ...state, revision: '100' })).toBe(false)
  expect(
    lifecycle.executionReceived(address, {
      ...state,
      epoch: 'second',
      revision: '1',
      phase: 'recovering',
    })
  ).toBe(true)
  expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(true)
  lifecycle.executionReceived(address, {
    ...state,
    epoch: 'second',
    revision: '2',
    phase: 'queued',
  })
  expect(lifecycle.snapshot().get(runtimeTaskKey(address))).toBe(false)
})
