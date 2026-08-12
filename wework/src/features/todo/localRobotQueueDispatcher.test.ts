import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { startLocalRobotQueueDispatcher } from './localRobotQueueDispatcher'

const LOCAL_QUEUE_POLL_MS = 3000

function execution(overrides: Partial<LocalLoopItemExecution> = {}): LocalLoopItemExecution {
  return {
    id: 1,
    loop_item_id: 'T-1',
    cloud_project_id: 'P-1',
    task_title: 'Run me',
    task_status: 'inbox',
    task_priority: 'none',
    agent_id: 'LA-1',
    assigner_user_id: 0,
    execution_environment: 'local',
    execution_device_id: 'local-device',
    status: 'queued',
    priority_weight: 20,
    queued_at: null,
    started_at: null,
    completed_at: null,
    lease_expires_at: null,
    heartbeat_at: null,
    retry_attempt: 0,
    error_message: '',
    execution_note: '',
    approval_status: null,
    approved_by_user_id: null,
    rejected_reason: null,
    runtime_device_id: null,
    runtime_task_id: null,
    execution_payload: { text: 'please run' },
    max_retries: 1,
    agent_name: 'Bot',
    agent_system_prompt: '',
    agent_model: null,
    version: 1,
    created_at: '2026-08-07T00:00:00+00:00',
    updated_at: '2026-08-07T00:00:00+00:00',
    ...overrides,
  }
}

function services(
  overrides: {
    claimNext?: ReturnType<typeof vi.fn>
    heartbeat?: ReturnType<typeof vi.fn>
    fail?: ReturnType<typeof vi.fn>
    recoverStale?: ReturnType<typeof vi.fn>
    createRuntimeTask?: ReturnType<typeof vi.fn>
    devices?: Array<{ device_id: string; device_type?: string }>
    listDevices?: ReturnType<typeof vi.fn>
  } = {}
) {
  const claimNext = overrides.claimNext ?? vi.fn(async () => execution())
  const heartbeat = overrides.heartbeat ?? vi.fn(async () => execution({ status: 'running' }))
  const fail = overrides.fail ?? vi.fn(async () => execution({ status: 'failed' }))
  const recoverStale = overrides.recoverStale ?? vi.fn(async () => ({ requeued: 0, failed: 0 }))
  const createRuntimeTask =
    overrides.createRuntimeTask ??
    vi.fn(async () => ({
      accepted: true,
      deviceId: 'local-device',
      taskId: 'codex-queue-1-123',
      workspacePath: '/tmp/workspace',
    }))
  const listDevices =
    overrides.listDevices ??
    vi.fn(async () => overrides.devices ?? [{ device_id: 'local-device', device_type: 'local' }])
  return {
    services: {
      localLoopItemExecutionApi: {
        list: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        claimNext,
        heartbeat,
        complete: vi.fn(),
        fail,
        recoverStale,
      },
      runtimeWorkApi: {
        createRuntimeTask,
      },
      deviceApi: {
        listDevices,
        getHomeDirectory: vi.fn(async () => '/home/wework'),
        createDirectory: vi.fn(async () => undefined),
      },
    } as unknown as WorkbenchServices,
    mocks: { claimNext, heartbeat, fail, recoverStale, createRuntimeTask, listDevices },
  }
}

describe('startLocalRobotQueueDispatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('claims from every local-capable device', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(execution({ execution_device_id: 'app-device' }))
    const { services: svc, mocks } = services({
      claimNext,
      devices: [
        { device_id: 'local-device', device_type: 'local' },
        { device_id: 'app-device', device_type: 'app' },
      ],
    })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()
    expect(claimNext).toHaveBeenNthCalledWith(1, {
      execution_device_id: 'local-device',
      device_capacity: 5,
      lease_seconds: 300,
    })
    expect(claimNext).toHaveBeenNthCalledWith(2, {
      execution_device_id: 'app-device',
      device_capacity: 5,
      lease_seconds: 300,
    })
    expect(mocks.createRuntimeTask).toHaveBeenCalledOnce()
    stop()
  })

  it('falls back to local-device when no devices resolve', async () => {
    const claimNext = vi.fn().mockResolvedValueOnce(execution()).mockResolvedValue(null)
    const listDevices = vi.fn(async () => [])
    const { services: svc, mocks } = services({ claimNext, listDevices })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()
    expect(claimNext).toHaveBeenCalledWith({
      execution_device_id: 'local-device',
      device_capacity: 5,
      lease_seconds: 300,
    })
    expect(mocks.createRuntimeTask).toHaveBeenCalledOnce()
    stop()
  })

  it('heartbeats the claimed run and keeps the lease alive', async () => {
    const heartbeat = vi.fn(async () => execution({ status: 'running' }))
    const claimNext = vi.fn().mockResolvedValueOnce(execution()).mockResolvedValue(null)
    const { services: svc } = services({ heartbeat, claimNext })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.advanceTimersByTimeAsync(0)
    // Initial heartbeat after createRuntimeTask.
    expect(heartbeat).toHaveBeenCalledWith(1, 'local-device', 'codex-queue-1-123', 300)
    const initialCalls = heartbeat.mock.calls.length
    // 60s later the keeper heartbeats again.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heartbeat.mock.calls.length).toBeGreaterThan(initialCalls)
    stop()
  })

  it('stops heartbeating once the run is terminal', async () => {
    const heartbeat = vi
      .fn()
      .mockResolvedValueOnce(execution({ status: 'running' }))
      .mockResolvedValue(null)
    const claimNext = vi.fn().mockResolvedValueOnce(execution()).mockResolvedValue(null)
    const { services: svc } = services({ heartbeat, claimNext })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterKeeperStop = () => heartbeat.mock.calls.length
    const afterFirst = callsAfterKeeperStop()
    await vi.advanceTimersByTimeAsync(60_000)
    // First keeper beat returns null (terminal) and stops the timer.
    expect(heartbeat.mock.calls.length).toBeGreaterThan(afterFirst)
    const afterTerminal = heartbeat.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heartbeat.mock.calls.length).toBe(afterTerminal)
    stop()
  })

  it('fails the execution when runtime task creation throws', async () => {
    const createRuntimeTask = vi.fn(async () => {
      throw new Error('workspace unavailable')
    })
    const fail = vi.fn(async () => execution({ status: 'failed' }))
    const { services: svc, mocks } = services({ createRuntimeTask, fail })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()
    expect(fail).toHaveBeenCalledWith(1, expect.stringContaining('workspace unavailable'))
    expect(mocks.heartbeat).not.toHaveBeenCalled()
    stop()
  })

  it('sends the robot role description without embedding the task content', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({
          agent_name: '发布机器人',
          agent_system_prompt: '只读检查',
          execution_payload: {},
        })
      )
      .mockResolvedValue(null)
    const { services: svc, mocks } = services({ claimNext })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    const call = mocks.createRuntimeTask.mock.calls[0][0] as Record<string, unknown>
    expect(call.message).toBe('你是 发布机器人，这个项目任务的 AI 执行者。\n只读检查')
    expect(call.message).not.toContain('请开始执行任务')
    expect(call.message).not.toContain('Run me')
    const context = call.additionalContext as Record<string, { kind: string; value: string }>
    expect(context.projectChat.value).toContain('get_board_item')
    expect(context.projectChat.value).toContain('do not call list_spaces')
    expect(context.projectChatAgent.value).toContain('你是 发布机器人')
    stop()
  })

  it('recovers stale runs on the recovery interval', async () => {
    const recoverStale = vi.fn(async () => ({ requeued: 1, failed: 0 }))
    const claimNext = vi.fn(async () => null)
    const { services: svc, mocks } = services({ recoverStale, claimNext })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.recoverStale).toHaveBeenCalled()
    stop()
  })
})
