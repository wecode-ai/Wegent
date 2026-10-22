import { describe, expect, it } from 'vitest'
import type { DeviceInfo, RuntimeTaskSummary } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

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
