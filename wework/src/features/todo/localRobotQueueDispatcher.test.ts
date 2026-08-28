import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalLoopItemExecution } from '@/api/local/localDelivery'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  startLocalRobotQueueDispatcher,
  stopLocalRobotQueueExecution,
} from './localRobotQueueDispatcher'

const LOCAL_QUEUE_POLL_MS = 3000

function runtimePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const taskId = typeof overrides.taskId === 'string' ? overrides.taskId : 'codex-queue-1'
  const message = typeof overrides.message === 'string' ? overrides.message : 'backend prompt'
  return {
    taskId,
    teamId: 7,
    runtime: 'codex',
    message,
    title: 'Run me',
    cloudProjectId: 'P-1',
    modelId: 'local-model',
    modelType: 'runtime',
    modelOptions: { collaborationMode: 'default' },
    bot: [{ id: 'LA-1', name: 'Bot', shell_type: 'codex' }],
    standaloneChatWorkspace: true,
    origin: {
      type: 'project_automation',
      cloudProjectId: 'P-1',
      loopItemId: 'T-1',
    },
    additionalContext: {
      task: { kind: 'application', value: '{"id":"T-1","title":"Run me"}' },
    },
    ...overrides,
  }
}

function localModelIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return runtimePayload({ modelId: 'local-model', ...overrides })
}

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
    display_state: 'queued',
    observed_state: 'unconfirmed',
    sync_state: 'pending',
    priority_weight: 20,
    queued_at: null,
    started_at: null,
    completed_at: null,
    lease_expires_at: null,
    heartbeat_at: null,
    claimed_at: null,
    start_requested_at: null,
    observed_at: null,
    cancel_requested_at: null,
    attempt_no: 1,
    previous_execution_id: null,
    execution_scope: 'project_robot:T-1',
    last_event_seq: 0,
    termination_reason: '',
    retry_attempt: 0,
    error_message: '',
    execution_note: '',
    approval_status: null,
    approved_by_user_id: null,
    rejected_reason: null,
    runtime_device_id: null,
    runtime_task_id: 'codex-queue-1',
    runtime_payload: runtimePayload(),
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
    startRequested?: ReturnType<typeof vi.fn>
    dispatchUnknown?: ReturnType<typeof vi.fn>
    recoverStale?: ReturnType<typeof vi.fn>
    listStale?: ReturnType<typeof vi.fn>
    reconcile?: ReturnType<typeof vi.fn>
    createRuntimeTask?: ReturnType<typeof vi.fn>
    cloudClaimNext?: ReturnType<typeof vi.fn>
    runtimeStart?: ReturnType<typeof vi.fn>
    cloudStartRequested?: ReturnType<typeof vi.fn>
    cloudDispatchUnknown?: ReturnType<typeof vi.fn>
    runtimeWork?: Array<Record<string, unknown>>
    devices?: Array<{ device_id: string; device_type?: string }>
    listDevices?: ReturnType<typeof vi.fn>
    listModels?: ReturnType<typeof vi.fn>
  } = {}
) {
  const claimNext = overrides.claimNext ?? vi.fn(async () => execution())
  const heartbeat = overrides.heartbeat ?? vi.fn(async () => execution({ status: 'running' }))
  const fail = overrides.fail ?? vi.fn(async () => execution({ status: 'failed' }))
  const startRequested =
    overrides.startRequested ?? vi.fn(async () => execution({ status: 'claimed' }))
  const dispatchUnknown =
    overrides.dispatchUnknown ?? vi.fn(async () => execution({ sync_state: 'stale' }))
  const recoverStale = overrides.recoverStale ?? vi.fn(async () => ({ requeued: 0, unknown: 0 }))
  const listStale = overrides.listStale ?? vi.fn(async () => [])
  const reconcile = overrides.reconcile ?? vi.fn(async () => execution({ sync_state: 'in_sync' }))
  const createRuntimeTask =
    overrides.createRuntimeTask ??
    vi.fn(async () => ({
      accepted: true,
      deviceId: 'local-device',
      taskId: 'codex-queue-1',
      workspacePath: '/tmp/workspace',
    }))
  const listDevices =
    overrides.listDevices ??
    vi.fn(async () => overrides.devices ?? [{ device_id: 'local-device', device_type: 'local' }])
  const cloudClaimNext = overrides.cloudClaimNext ?? vi.fn(async () => null)
  const runtimeStart =
    overrides.runtimeStart ??
    vi.fn(async () =>
      execution({
        status: 'claimed',
        display_state: 'waiting_runtime',
        observed_state: 'accepted',
      })
    )
  const cloudStartRequested =
    overrides.cloudStartRequested ?? vi.fn(async () => execution({ status: 'claimed' }))
  const cloudDispatchUnknown =
    overrides.cloudDispatchUnknown ?? vi.fn(async () => execution({ sync_state: 'stale' }))
  const listModels =
    overrides.listModels ??
    vi.fn(async () => ({
      data: [
        {
          name: 'local-model',
          modelId: 'local-model',
          type: 'runtime' as const,
          provider: 'local',
          config: { weworkModelKind: 'codex-official', codexAuthConfigured: true },
        },
      ],
    }))
  const getHomeDirectory = vi.fn(async () => '/home/wework')
  return {
    services: {
      localLoopItemExecutionApi: {
        list: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
        claimNext,
        heartbeat,
        startRequested,
        runtimeStart,
        dispatchUnknown,
        dispatchFailed: fail,
        recoverStale,
        listStale,
        reconcile,
      },
      projectAutomationApi: {
        claimNext: cloudClaimNext,
        heartbeat,
        startRequested: cloudStartRequested,
        dispatchUnknown: cloudDispatchUnknown,
        runtimeStart,
        dispatchFailed: fail,
      },
      runtimeWorkApi: {
        createRuntimeTask,
        listRuntimeWork: vi.fn(async () => ({
          projects: overrides.runtimeWork ?? [],
          chats: [],
          totalTasks: 0,
        })),
      },
      deviceApi: {
        listDevices,
        getHomeDirectory,
        createDirectory: vi.fn(async () => undefined),
      },
      modelApi: { listModels },
    } as unknown as WorkbenchServices,
    mocks: {
      claimNext,
      heartbeat,
      fail,
      startRequested,
      dispatchUnknown,
      recoverStale,
      listStale,
      reconcile,
      createRuntimeTask,
      listDevices,
      cloudClaimNext,
      runtimeStart,
      cloudStartRequested,
      cloudDispatchUnknown,
      listModels,
      getHomeDirectory,
    },
  }
}

describe('stopLocalRobotQueueExecution', () => {
  it('terminalizes a provably unstarted execution without contacting Runtime', async () => {
    const cancel = vi.fn(async () => execution({ status: 'cancelled', display_state: 'cancelled' }))
    const cancelRuntimeTask = vi.fn()
    const stopped = await stopLocalRobotQueueExecution(
      { cancel } as unknown as NonNullable<WorkbenchServices['localLoopItemExecutionApi']>,
      { cancelRuntimeTask } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>,
      9
    )

    expect(cancel).toHaveBeenCalledWith(9)
    expect(stopped.status).toBe('cancelled')
    expect(cancelRuntimeTask).not.toHaveBeenCalled()
  })

  it('keeps a delivered execution cancelling until Runtime acknowledges stop', async () => {
    const cancelling = execution({
      status: 'cancel_requested',
      display_state: 'cancelling',
      runtime_device_id: 'local-device',
      runtime_task_id: 'codex-queue-9',
    })
    const cancel = vi.fn(async () => cancelling)
    const cancelRuntimeTask = vi.fn(async () => ({ accepted: true }))
    const stopped = await stopLocalRobotQueueExecution(
      { cancel } as unknown as NonNullable<WorkbenchServices['localLoopItemExecutionApi']>,
      { cancelRuntimeTask } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>,
      9
    )

    expect(stopped).toBe(cancelling)
    expect(cancelRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'codex-queue-9',
    })
    expect(stopped.status).toBe('cancel_requested')
  })
})

describe('startLocalRobotQueueDispatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lets Executor IPC supply the only local execution device identity', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(execution({ execution_device_id: 'app-device' }))
      .mockResolvedValue(null)
    const { services: svc, mocks } = services({
      claimNext,
    })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()
    expect(claimNext).toHaveBeenCalledWith({
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
    expect(heartbeat).not.toHaveBeenCalled()
    // Runtime acceptance is recorded separately; the lease keeper starts 60s later.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(heartbeat).toHaveBeenCalledWith(1, 'local-device', 'codex-queue-1', 300)
    stop()
  })

  it.each([
    { label: 'project robot', agentId: 'LA-1', agentName: 'Bot', botId: 'LA-1' },
    { label: 'inline custom', agentId: '', agentName: 'AI 托管', botId: 0 },
  ])('forwards the complete non-secret V2 intent for a $label', async testCase => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({
          agent_id: testCase.agentId,
          agent_name: testCase.agentName,
          runtime_payload: localModelIntent({
            taskId: 'codex-queue-1',
            teamId: 7,
            runtime: 'codex',
            message: 'inline custom prompt',
            title: 'Custom run',
            cloudProjectId: 'P-1',
            modelId: 'local-model',
            origin: {
              type: 'project_automation',
              cloudProjectId: 'P-1',
              loopItemId: 'T-1',
              run_id: 'run-inline',
            },
            additionalContext: {
              task: { kind: 'application', value: '{"id":"T-1"}' },
            },
            bot: [{ id: testCase.botId, name: testCase.agentName, shell_type: 'codex' }],
          }),
        })
      )
      .mockResolvedValue(null)
    const { services: svc, mocks } = services({ claimNext })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    expect(mocks.listModels).not.toHaveBeenCalled()
    expect(mocks.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'codex-queue-1',
        message: 'inline custom prompt',
        modelId: 'local-model',
        modelType: 'runtime',
        modelOptions: { collaborationMode: 'default' },
        bot: [{ id: testCase.botId, name: testCase.agentName, shell_type: 'codex' }],
        standaloneChatWorkspace: true,
      })
    )
    expect(mocks.createRuntimeTask.mock.calls[0][0].executionRequest).toBeUndefined()
    expect(mocks.fail).not.toHaveBeenCalled()
    stop()
  })

  it('leaves model availability validation to the Local Compiler', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({ runtime_payload: localModelIntent({ modelId: 'removed-local-model' }) })
      )
      .mockResolvedValue(null)
    const { services: svc, mocks } = services({
      claimNext,
      listModels: vi.fn(async () => ({ data: [] })),
    })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    expect(mocks.listModels).not.toHaveBeenCalled()
    expect(mocks.createRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'removed-local-model',
        modelType: 'runtime',
      })
    )
    stop()
  })

  it('rejects a backend-materialized request on the local claim boundary', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({
          runtime_payload: runtimePayload({
            executionRequest: {
              task_id: 'codex-queue-1',
              prompt: 'backend prompt',
              model_config: { api_key: 'must-not-cross-the-local-boundary' },
            },
          }),
        })
      )
      .mockResolvedValue(null)
    const fail = vi.fn(async () => execution({ status: 'failed' }))
    const { services: svc, mocks } = services({ claimNext, fail })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    expect(mocks.listModels).not.toHaveBeenCalled()
    expect(mocks.createRuntimeTask).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(
      1,
      'Local execution claims must not contain a backend-materialized execution request'
    )
    stop()
  })

  it('fails a mismatched claim-time runtime identity', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({
          runtime_task_id: 'codex-queue-1',
          runtime_payload: {
            taskId: 'different-runtime-task',
            teamId: 7,
            runtime: 'codex',
            message: 'runtime prompt',
            title: 'Run me',
            cloudProjectId: 'P-1',
            bot: [{ id: 'LA-1', name: 'Bot', shell_type: 'codex' }],
            origin: {
              type: 'project_automation',
              cloudProjectId: 'P-1',
              loopItemId: 'T-1',
            },
            additionalContext: {
              task: { kind: 'application', value: '{"id":"T-1"}' },
            },
            standaloneChatWorkspace: true,
            modelId: 'local-model',
          },
        })
      )
      .mockResolvedValue(null)
    const fail = vi.fn(async () => execution({ status: 'failed' }))
    const { services: svc, mocks } = services({ claimNext, fail })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    expect(mocks.createRuntimeTask).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(
      1,
      expect.stringContaining("Runtime task identity 'different-runtime-task'")
    )
    stop()
  })

  it('runs in the bound project workspace instead of a fresh conversation directory', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(execution({ runtime_payload: runtimePayload({ projectId: 7 }) }))
      .mockResolvedValue(null)
    const runtimeWork = [
      {
        project: {
          key: 'a2a',
          id: 7,
          name: 'A2A',
          kind: 'local',
          source: 'local_project',
          roots: [{ path: '/Users/me/A2A' }],
        },
        deviceWorkspaces: [
          { deviceId: 'local-device', available: true, workspacePath: '/Users/me/A2A', tasks: [] },
        ],
        totalTasks: 0,
      },
    ]
    const createRuntimeTask = vi.fn(async () => ({
      accepted: true,
      deviceId: 'local-device',
      taskId: 'codex-queue-1',
      workspacePath: '/Users/me/A2A',
      runtime: 'codex',
    }))
    const { services: svc, mocks } = services({
      claimNext,
      createRuntimeTask,
      runtimeWork,
    })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    const call = mocks.createRuntimeTask.mock.calls[0][0] as Record<string, unknown>
    expect(call.workspacePath).toBeUndefined()
    expect(call.projectId).toBe(7)
    expect(mocks.getHomeDirectory).not.toHaveBeenCalled()
    stop()
  })

  it('inherits the workspace from the predecessor runtime task', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({
          runtime_payload: runtimePayload({
            standaloneChatWorkspace: false,
            workspaceSourceTask: {
              deviceId: 'local-device',
              taskId: 'previous-runtime-task',
            },
          }),
        })
      )
      .mockResolvedValue(null)
    const runtimeWork = [
      {
        project: {
          key: 'a2a',
          id: 7,
          name: 'A2A',
          kind: 'local',
          source: 'local_project',
          roots: [{ path: '/Users/me/A2A' }],
        },
        deviceWorkspaces: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/Users/me/A2A',
            tasks: [
              {
                taskId: 'previous-runtime-task',
                title: 'Previous',
                runtime: 'codex',
                workspacePath: '/Users/me/A2A/.worktrees/previous',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
    ]
    const { services: svc, mocks } = services({ claimNext, runtimeWork })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    const call = mocks.createRuntimeTask.mock.calls[0][0] as Record<string, unknown>
    expect(call.workspacePath).toBeUndefined()
    expect(call.workspaceSourceTask).toEqual({
      deviceId: 'local-device',
      taskId: 'previous-runtime-task',
    })
    expect(mocks.getHomeDirectory).not.toHaveBeenCalled()
    stop()
  })

  it('treats local project zero as an unbound standalone workspace', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({ runtime_payload: runtimePayload({ projectId: undefined }) })
      )
      .mockResolvedValue(null)
    const { services: svc, mocks } = services({ claimNext, runtimeWork: [] })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    expect(mocks.createRuntimeTask).toHaveBeenCalledTimes(1)
    const call = mocks.createRuntimeTask.mock.calls[0][0] as Record<string, unknown>
    expect(call.projectId).toBeUndefined()
    expect(call.standaloneChatWorkspace).toBe(true)
    expect(mocks.getHomeDirectory).not.toHaveBeenCalled()
    expect(mocks.fail).not.toHaveBeenCalled()
    stop()
  })

  it('passes an exact project binding to the Local Compiler without fallback', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(execution({ runtime_payload: runtimePayload({ projectId: 7 }) }))
      .mockResolvedValue(null)
    const { services: svc, mocks } = services({ claimNext, runtimeWork: [] })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    expect(mocks.createRuntimeTask).toHaveBeenCalledWith(expect.objectContaining({ projectId: 7 }))
    expect(mocks.getHomeDirectory).not.toHaveBeenCalled()
    stop()
  })

  it('stops heartbeating once the run is terminal', async () => {
    const heartbeat = vi.fn().mockResolvedValue(null)
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

  it('marks the fenced execution unknown when runtime task creation throws', async () => {
    const createRuntimeTask = vi.fn(async () => {
      throw new Error('workspace unavailable')
    })
    const fail = vi.fn(async () => execution({ status: 'failed' }))
    const dispatchUnknown = vi.fn(async () => execution({ sync_state: 'stale' }))
    const claimNext = vi.fn().mockResolvedValueOnce(execution()).mockResolvedValue(null)
    const { services: svc, mocks } = services({
      createRuntimeTask,
      dispatchUnknown,
      fail,
      claimNext,
    })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()
    expect(dispatchUnknown).toHaveBeenCalledWith(
      1,
      'local-device',
      'codex-queue-1',
      expect.stringContaining('workspace unavailable')
    )
    expect(fail).not.toHaveBeenCalled()
    expect(mocks.heartbeat).not.toHaveBeenCalled()
    stop()
  })

  it('fails a claimed row without a transient runtime payload', async () => {
    const claimNext = vi
      .fn()
      .mockResolvedValueOnce(
        execution({
          runtime_payload: null,
        })
      )
      .mockResolvedValue(null)
    const fail = vi.fn(async () => execution({ status: 'failed' }))
    const { services: svc, mocks } = services({ claimNext, fail })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(LOCAL_QUEUE_POLL_MS)
    await vi.runOnlyPendingTimersAsync()

    expect(mocks.createRuntimeTask).not.toHaveBeenCalled()
    expect(fail).toHaveBeenCalledWith(1, 'Execution claim is missing its transient runtime payload')
    stop()
  })

  it('recovers stale runs on the recovery interval', async () => {
    const recoverStale = vi.fn(async () => ({ requeued: 1, unknown: 0 }))
    const claimNext = vi.fn(async () => null)
    const { services: svc, mocks } = services({ recoverStale, claimNext })
    const stop = startLocalRobotQueueDispatcher(svc)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.recoverStale).toHaveBeenCalled()
    stop()
  })

  it('reconciles stale local executions from the exact Runtime task snapshot', async () => {
    const stale = execution({
      status: 'claimed',
      display_state: 'unknown',
      sync_state: 'stale',
      runtime_device_id: 'local-device',
      runtime_task_id: 'codex-queue-1',
    })
    const listStale = vi.fn(async () => [stale])
    const reconcile = vi.fn(async () =>
      execution({ status: 'completed', display_state: 'succeeded' })
    )
    const claimNext = vi.fn(async () => null)
    const { services: svc } = services({
      claimNext,
      listStale,
      reconcile,
      runtimeWork: [
        {
          project: { id: 7, name: 'Bound project', roots: [] },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              available: true,
              workspacePath: '/tmp/workspace',
              tasks: [
                {
                  taskId: 'codex-queue-1',
                  workspacePath: '/tmp/workspace',
                  title: 'Run me',
                  runtime: 'codex',
                  status: 'active',
                  running: false,
                  turnStatus: 'completed',
                },
              ],
            },
          ],
        },
      ],
    })
    const stop = startLocalRobotQueueDispatcher(svc)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(reconcile).toHaveBeenCalledWith(1, {
      runtime_status: 'active',
      running: false,
      turn_status: 'completed',
    })
    stop()
  })
})
