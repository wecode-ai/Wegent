import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTaskSummary } from '@/types/runtime'
import {
  MobileTaskTelemetryObserver,
  type MobileTaskTelemetryTracker,
} from './mobileTaskTelemetryObserver'
import { clearMobileTaskAddressRenames, recordMobileTaskAddressRename } from './taskIdentity'
import { clearMobileTaskOutcomes, recordMobileTaskOutcome } from './taskOutcome'

vi.mock('./mobileTelemetry', () => ({ mobileTelemetry: { track: vi.fn() } }))

const device = {
  id: 1,
  device_id: 'device',
  name: 'Device',
  status: 'online' as const,
  device_type: 'local' as const,
  bind_shell: 'claudecode' as const,
}

function task(taskId: string, running: boolean, status = running ? 'running' : 'completed') {
  return {
    taskId,
    title: taskId,
    runtime: 'codex',
    workspacePath: '/workspace',
    running,
    status,
  } satisfies RuntimeTaskSummary
}

function work(taskSummary: RuntimeTaskSummary) {
  return {
    projects: [],
    chats: [
      {
        deviceId: 'device',
        deviceName: 'Device',
        deviceStatus: 'online',
        available: true,
        workspacePath: '/workspace',
        tasks: [taskSummary],
      },
    ],
    totalTasks: 1,
  }
}

describe('mobile task telemetry observation', () => {
  afterEach(() => {
    clearMobileTaskAddressRenames()
    clearMobileTaskOutcomes()
  })

  it('uses the task snapshot when the lifecycle override is absent', () => {
    const trackMock = vi.fn()
    const track = trackMock as unknown as MobileTaskTelemetryTracker
    const observer = new MobileTaskTelemetryObserver(track)
    observer.observe({
      work: work(task('task-1', true)),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 1_000,
    })
    observer.observe({
      work: work(task('task-1', true)),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 2_000,
    })
    expect(trackMock.mock.calls.map(([name]) => name)).toEqual(['mobile_task_started'])

    observer.observe({
      work: work(task('task-1', false, 'failed')),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 3_000,
    })
    expect(trackMock.mock.calls.map(([name]) => name)).toEqual([
      'mobile_task_started',
      'mobile_task_completed',
    ])
    expect(trackMock.mock.calls[1]?.[1]).toMatchObject({ result: 'failure', duration_ms: 2_000 })
  })

  it('does not apply a stale terminal outcome to the next execution', () => {
    const trackMock = vi.fn()
    const track = trackMock as unknown as MobileTaskTelemetryTracker
    const observer = new MobileTaskTelemetryObserver(track)
    recordMobileTaskOutcome(
      { deviceId: 'device', taskId: 'task-1', runtime: 'codex' },
      'runtime.task.cancelled'
    )
    observer.observe({
      work: work(task('task-1', true)),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 1_000,
    })
    observer.observe({
      work: work(task('task-1', false)),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 2_000,
    })
    expect(trackMock.mock.calls[1]?.[1]).toMatchObject({ result: 'success' })
  })

  it('moves observation state when a provisional task ID becomes final', () => {
    const trackMock = vi.fn()
    const track = trackMock as unknown as MobileTaskTelemetryTracker
    const observer = new MobileTaskTelemetryObserver(track)
    const provisional = {
      deviceId: 'device',
      taskId: 'runtime-temp',
      runtime: 'codex' as const,
      workspacePath: '/workspace',
    }
    const final = { ...provisional, taskId: 'runtime-final' }
    observer.observe({
      work: work(task('runtime-temp', true)),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 1_000,
    })
    recordMobileTaskAddressRename(provisional, final)
    observer.observe({
      work: work(task('runtime-final', true)),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 2_000,
    })
    expect(trackMock.mock.calls.map(([name]) => name)).toEqual(['mobile_task_started'])

    observer.observe({
      work: work(task('runtime-final', false, 'failed')),
      taskRunningByKey: new Map(),
      devices: [device],
      now: 3_000,
    })
    expect(trackMock.mock.calls.map(([name]) => name)).toEqual([
      'mobile_task_started',
      'mobile_task_completed',
    ])
    expect(trackMock.mock.calls[1]?.[1]).toMatchObject({ result: 'failure', duration_ms: 2_000 })
  })
})
