import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useWorkbenchTelemetry } from './useWorkbenchTelemetry'
import type { DeviceInfo, RuntimeTaskLifecycleStoreSnapshot } from '@/types/api'

const trackMock = vi.fn()

vi.mock('@/telemetry/client', () => ({
  track: (...args: unknown[]) => trackMock(...args),
}))

const device: DeviceInfo = {
  device_id: 'local-device',
  device_type: 'local',
  name: 'Local',
} as DeviceInfo

function makeSnapshot(overrides?: {
  isRunning?: boolean
  isTurnActive?: boolean
  status?: string
  turnStatus?: string
  error?: string
}): RuntimeTaskLifecycleStoreSnapshot {
  return {
    version: 1,
    tasks: new Map([
      [
        'local-device\0task-42',
        {
          key: 'local-device\0task-42',
          address: { deviceId: 'local-device', taskId: 'task-42' },
          task: overrides
            ? {
                id: 'task-42',
                status: overrides.status ?? 'done',
                turnStatus: overrides.turnStatus ?? 'done',
                threadStatus: 'idle',
                error: overrides.error,
              }
            : null,
          execution: {
            phase: (overrides?.isRunning ?? false) ? 'running' : 'idle',
            known: true,
            running: overrides?.isRunning ?? false,
          },
          turn: {
            phase: (overrides?.isTurnActive ?? false) ? 'streaming' : 'idle',
            active: overrides?.isTurnActive ?? false,
          },
          goalStatus: null,
          continuable: false,
          unread: false,
          derived: {
            executionKnown: true,
            isRunning: overrides?.isRunning ?? false,
            isTurnActive: overrides?.isTurnActive ?? false,
            isThinking: false,
            isBusy: false,
            canSend: true,
            canQueue: true,
            shouldShowSidebarRunning: false,
            shouldShowUnread: false,
          },
        },
      ],
    ]),
    runningTaskKeys: new Set(),
    unreadTaskKeys: new Set(),
  }
}

describe('useWorkbenchTelemetry', () => {
  beforeEach(() => {
    trackMock.mockReset()
  })

  test('emits $ai_trace start when a task starts running', () => {
    renderHook(() =>
      useWorkbenchTelemetry({
        currentProject: null,
        devices: [device],
        lifecycle: makeSnapshot({ isRunning: true }),
      })
    )

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $ai_trace_id: 'task-42',
        $ai_trace_phase: 'start',
        execution_target: 'local',
      })
    )
  })

  test('emits $ai_trace end when a running task settles', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      {
        initialProps: { lifecycle: makeSnapshot({ isRunning: true }) },
      }
    )

    trackMock.mockReset()
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $ai_trace_id: 'task-42',
        $ai_trace_phase: 'end',
        execution_target: 'local',
        result: 'success',
      })
    )
  })

  test('includes failure_reason on $ai_trace end when task failed', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      {
        initialProps: { lifecycle: makeSnapshot({ isRunning: true }) },
      }
    )

    trackMock.mockReset()
    rerender({
      lifecycle: makeSnapshot({
        isRunning: false,
        status: 'failed',
        turnStatus: 'failed',
        error: 'model provider error',
      }),
    })

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $ai_trace_id: 'task-42',
        $ai_trace_phase: 'end',
        result: 'failure',
        failure_reason: 'model_error',
      })
    )
  })
})
