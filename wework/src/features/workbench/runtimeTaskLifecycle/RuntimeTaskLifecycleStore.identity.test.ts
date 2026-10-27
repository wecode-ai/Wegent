import { describe, expect, it } from 'vitest'
import type { DeviceInfo, RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

function completedSuccessorTurn() {
  const address = { deviceId: 'cloud-device', taskId: 'task-1' }
  const store = new RuntimeTaskLifecycleStore('completed-successor-turn')
  const previous: RuntimeTaskSummary = {
    taskId: address.taskId,
    title: 'Long conversation',
    workspacePath: '/workspace',
    runtime: 'codex',
    running: false,
    status: 'done',
    completedAt: 1_793_091_610_220,
    updatedAt: 1_793_091_610_220,
    runtimeHandle: { lastTurnId: 'previous-turn' },
  }
  store.syncRuntimeTask(address, previous)
  store.turnStarted(address, 'previous-turn')
  store.turnSettled(address, 'previous-turn', 'succeeded')
  store.sendRequested(address)
  store.sendAccepted(address)
  store.turnStarted(address, 'completed-turn')
  store.turnSettled(address, 'completed-turn', 'succeeded')
  store.syncTranscript(address, {
    taskId: address.taskId,
    running: false,
    messages: [],
    turns: [
      { id: 'completed-turn', status: 'completed', completedAt: 1_793_091_612_000, items: [] },
    ],
  })
  const delayedAdmission: RuntimeTaskSummary = {
    ...previous,
    status: 'running',
    running: true,
    threadStatus: 'idle',
    turnStatus: 'inProgress',
    completedAt: null,
    updatedAt: 1_793_091_612_332,
  }
  return { address, store, delayedAdmission }
}

describe('runtime task lifecycle turn identity', () => {
  it('does not revive a completed successor from its delayed admission snapshot', () => {
    const { address, store, delayedAdmission } = completedSuccessorTurn()
    expect(store.getTask(address)?.execution.running).toBe(false)

    store.syncRuntimeTask(address, delayedAdmission)

    expect(store.getTask(address)?.execution.running).toBe(false)
    expect(store.getTask(address)?.turn.latestId).toBe('completed-turn')
    expect(store.getTask(address)?.task?.status).toBe('done')
  })

  it('accepts a new admission in the same second when it references the latest turn', () => {
    const { address, store, delayedAdmission } = completedSuccessorTurn()

    store.syncRuntimeTask(address, {
      ...delayedAdmission,
      runtimeHandle: { lastTurnId: 'completed-turn' },
    })

    expect(store.getTask(address)?.execution.running).toBe(true)
    expect(store.getTask(address)?.turn.latestId).toBe('completed-turn')
  })
})

describe('runtime task lifecycle device identity', () => {
  it.each(['alias', 'canonical'] as const)(
    'keeps the newer completed turn from the %s when identities merge',
    completedIdentity => {
      const store = new RuntimeTaskLifecycleStore(`completed-${completedIdentity}`)
      const canonical = { deviceId: 'electron-local', taskId: 'task-1' }
      const alias = { ...canonical, deviceId: 'app-record-65' }
      const completed = completedIdentity === 'alias' ? alias : canonical
      const stale = completedIdentity === 'alias' ? canonical : alias
      const task: RuntimeTaskSummary = {
        taskId: canonical.taskId,
        title: 'Check CPU',
        workspacePath: '',
        runtime: 'codex',
        continuable: true,
      }
      store.syncRuntimeTask(stale, {
        ...task,
        running: true,
        status: 'running',
        updatedAt: 1000,
      })
      store.turnStarted(stale, 'old-turn')
      store.syncRuntimeTask(completed, {
        ...task,
        running: false,
        status: 'done',
        completedAt: 2000,
        updatedAt: 2000,
      })
      store.turnStarted(completed, 'new-turn')
      store.turnSettled(completed, 'new-turn', 'succeeded')
      store.executorSettled(completed)

      store.syncDevices([
        {
          id: 65,
          device_id: canonical.deviceId,
          socket_device_id: alias.deviceId,
          runtime_instance_id: 'runtime-local',
          name: 'Local Executor',
          status: 'online',
          is_default: true,
          device_type: 'local',
          bind_shell: 'codex',
        },
      ])

      expect(store.getSnapshot().tasks.size).toBe(1)
      expect(store.getTask(alias)?.key).toBe(store.getTask(canonical)?.key)
      expect(store.getTask(canonical)?.task?.status).toBe('done')
      expect(store.getTask(canonical)?.execution.running).toBe(false)
      expect(store.getTask(canonical)?.turn).toMatchObject({
        phase: 'idle',
        id: null,
        latestId: 'new-turn',
        outcome: 'succeeded',
      })

      store.syncRuntimeTask(canonical, {
        ...task,
        running: true,
        status: 'running',
        threadStatus: 'active',
        turnStatus: 'inProgress',
        updatedAt: 3000,
        runtimeHandle: { lastTurnId: 'old-turn' },
      })
      expect(store.getTask(canonical)?.execution.running).toBe(false)
      expect(store.getTask(canonical)?.turn.latestId).toBe('new-turn')

      store.turnStarted(canonical, 'correction-after-merge')
      store.syncTranscript(alias, {
        taskId: canonical.taskId,
        messages: [],
        running: false,
        turns: [{ id: 'old-turn', status: 'completed', completedAt: 1000, items: [] }],
      })
      expect(store.getTask(canonical)?.turn.id).toBe('correction-after-merge')
      expect(store.getTask(alias)?.derived.shouldShowSidebarRunning).toBe(true)
    }
  )

  it('keeps independent task states when different runtime instances advertise the same alias', () => {
    const store = new RuntimeTaskLifecycleStore('ambiguous-runtime-identity')
    const local = { deviceId: 'electron-local', taskId: 'task-1' }
    const remote = { ...local, deviceId: 'remote-device' }
    const task: RuntimeTaskSummary = {
      taskId: local.taskId,
      title: 'Check CPU',
      workspacePath: '',
      runtime: 'codex',
      continuable: true,
      running: false,
    }
    store.syncRuntimeTask(local, { ...task, running: true })
    store.syncRuntimeTask(remote, task)
    const device: DeviceInfo = {
      id: 65,
      device_id: local.deviceId,
      runtime_instance_id: 'local-runtime',
      name: 'Local Executor',
      status: 'online',
      is_default: true,
      device_type: 'local',
      bind_shell: 'codex',
    }

    store.syncDevices([
      device,
      {
        ...device,
        id: 66,
        device_id: remote.deviceId,
        app_device_id: local.deviceId,
        runtime_instance_id: 'remote-runtime',
        device_type: 'remote',
      },
    ])

    expect(store.getSnapshot().tasks.size).toBe(2)
    expect(store.getTask(local)?.execution.running).toBe(true)
    expect(store.getTask(remote)?.execution.running).toBe(false)
  })
})
