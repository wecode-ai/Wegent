import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useWorkbenchTelemetry } from './useWorkbenchTelemetry'
import { resetRuntimeRunTraceIds, telemetryTraceId } from '@/telemetry/traceId'
import {
  recordGenerationOutcome,
  resetGenerationOutcomesForTests,
} from './runtimeGenerationOutcome'
import type { DeviceInfo, RuntimeTaskLifecycleStoreSnapshot } from '@/types/api'

const trackMock = vi.fn()

vi.mock('@/telemetry/client', () => ({
  track: (...args: unknown[]) => trackMock(...args),
}))

let uuidCounter = 0
vi.stubGlobal('crypto', {
  randomUUID: () => `run-uuid-${++uuidCounter}`,
})

const RUN_TRACE_ID = telemetryTraceId('run-uuid-1')

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
  executionPhase?: string
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
            phase:
              overrides?.executionPhase ?? ((overrides?.isRunning ?? false) ? 'running' : 'idle'),
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
    queuedTaskKeys: new Set(),
    unreadTaskKeys: new Set(),
  }
}

describe('useWorkbenchTelemetry', () => {
  beforeEach(() => {
    trackMock.mockReset()
    uuidCounter = 0
    resetRuntimeRunTraceIds()
    resetGenerationOutcomesForTests()
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
        $ai_trace_id: RUN_TRACE_ID,
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
        $ai_trace_id: RUN_TRACE_ID,
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
        $ai_trace_id: RUN_TRACE_ID,
        $ai_trace_phase: 'end',
        result: 'failure',
        failure_reason: 'model_error',
      })
    )
  })

  test('reports a failed generation outcome on $ai_trace end even when the task record is clean', () => {
    recordGenerationOutcome({ deviceId: 'local-device', taskId: 'task-42' }, 'failure')
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      { initialProps: { lifecycle: makeSnapshot({ isRunning: true }) } }
    )

    trackMock.mockReset()
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $ai_trace_id: RUN_TRACE_ID,
        $ai_trace_phase: 'end',
        result: 'failure',
      })
    )
  })

  test('reports a cancelled generation outcome on task_completed', () => {
    recordGenerationOutcome({ deviceId: 'local-device', taskId: 'task-42' }, 'cancelled')
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      { initialProps: { lifecycle: makeSnapshot({ isRunning: true }) } }
    )

    trackMock.mockReset()
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })

    expect(trackMock).toHaveBeenCalledWith(
      'task_completed',
      expect.objectContaining({
        result: 'cancelled',
      })
    )
  })

  test('reports the generation outcome on first_response_completed', () => {
    recordGenerationOutcome({ deviceId: 'local-device', taskId: 'task-42' }, 'cancelled')
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      {
        initialProps: { lifecycle: makeSnapshot({ isRunning: true, isTurnActive: true }) },
      }
    )

    trackMock.mockReset()
    rerender({ lifecycle: makeSnapshot({ isRunning: true, isTurnActive: false }) })

    expect(trackMock).toHaveBeenCalledWith(
      'first_response_completed',
      expect.objectContaining({
        result: 'cancelled',
      })
    )
  })

  test('does not leak a generation outcome into a subsequent run of the same task', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      { initialProps: { lifecycle: makeSnapshot({ isRunning: true }) } }
    )
    recordGenerationOutcome({ deviceId: 'local-device', taskId: 'task-42' }, 'failure')
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })
    trackMock.mockReset()

    // A new run without a generation outcome must fall back to the task result.
    rerender({ lifecycle: makeSnapshot({ isRunning: true }) })
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $ai_trace_phase: 'end',
        result: 'success',
      })
    )
  })

  test('mints a fresh trace id for a subsequent run of the same task', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      {
        initialProps: { lifecycle: makeSnapshot({ isRunning: true }) },
      }
    )
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })
    trackMock.mockReset()

    // A new run of the same task must not reuse the previous run's trace id.
    rerender({ lifecycle: makeSnapshot({ isRunning: true }) })

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $ai_trace_phase: 'start',
      })
    )
    const start = trackMock.mock.calls.find(
      (call: unknown[]) => call[0] === '$ai_trace' && call[1]?.$ai_trace_phase === 'start'
    )
    expect(start?.[1]?.$ai_trace_id).not.toBe(RUN_TRACE_ID)
    expect(start?.[1]?.$ai_trace_id).toMatch(/^t-[a-z0-9]+$/)
  })

  test('flushes an end event for an open run on beforeunload', () => {
    renderHook(() =>
      useWorkbenchTelemetry({
        currentProject: null,
        devices: [device],
        lifecycle: makeSnapshot({ isRunning: true }),
      })
    )
    trackMock.mockReset()

    window.dispatchEvent(new Event('beforeunload'))

    expect(trackMock).toHaveBeenCalledWith(
      '$ai_trace',
      expect.objectContaining({
        $ai_trace_id: RUN_TRACE_ID,
        $ai_trace_phase: 'end',
        result: 'cancelled',
        execution_target: 'local',
      })
    )
  })

  test('emits generation_regenerated when a task runs again after settling', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      {
        initialProps: { lifecycle: makeSnapshot({ isRunning: true }) },
      }
    )
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })
    trackMock.mockReset()

    rerender({ lifecycle: makeSnapshot({ isRunning: true }) })

    expect(trackMock).toHaveBeenCalledWith(
      'generation_regenerated',
      expect.objectContaining({
        execution_target: 'local',
        turn_count: 2,
      })
    )
  })

  test('does not emit generation_regenerated on the first run of a task', () => {
    renderHook(() =>
      useWorkbenchTelemetry({
        currentProject: null,
        devices: [device],
        lifecycle: makeSnapshot({ isRunning: true }),
      })
    )

    expect(trackMock).not.toHaveBeenCalledWith('generation_regenerated', expect.anything())
  })

  test('emits task_retried when a task is re-run shortly after completing', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      {
        initialProps: { lifecycle: makeSnapshot({ isRunning: true }) },
      }
    )
    rerender({ lifecycle: makeSnapshot({ isRunning: false, status: 'done', turnStatus: 'done' }) })
    trackMock.mockReset()

    rerender({ lifecycle: makeSnapshot({ isRunning: true }) })

    expect(trackMock).toHaveBeenCalledWith(
      'task_retried',
      expect.objectContaining({
        execution_target: 'local',
        previous_result: 'success',
      })
    )
  })

  test('emits task_interrupted when the task enters the stopping phase', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      {
        initialProps: { lifecycle: makeSnapshot({ isRunning: true }) },
      }
    )
    trackMock.mockReset()

    rerender({ lifecycle: makeSnapshot({ isRunning: true, executionPhase: 'stopping' }) })

    expect(trackMock).toHaveBeenCalledWith(
      'task_interrupted',
      expect.objectContaining({
        execution_target: 'local',
        after_first_response: false,
      })
    )
  })

  test('does not re-emit for a task whose lifecycle flags are unchanged', () => {
    const { rerender } = renderHook(
      ({ lifecycle }) =>
        useWorkbenchTelemetry({ currentProject: null, devices: [device], lifecycle }),
      { initialProps: { lifecycle: makeSnapshot({ isRunning: true }) } }
    )
    trackMock.mockReset()

    // A fresh snapshot with identical running/turn/stopping flags must not
    // re-trigger any tracking.
    rerender({ lifecycle: makeSnapshot({ isRunning: true }) })

    expect(trackMock).not.toHaveBeenCalled()
  })
})
