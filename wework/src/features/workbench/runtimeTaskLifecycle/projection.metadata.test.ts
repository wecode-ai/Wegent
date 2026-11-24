import { describe, expect, test } from 'vitest'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { initialWorkbenchState, workbenchReducer } from '../workbenchReducer'
import { mergeRuntimeWorkLists } from '../runtimeWorkMerge'

const address = { deviceId: 'device', taskId: 'task', workspacePath: '/work' }
const previous: RuntimeTaskSummary = {
  ...address,
  title: 'Waiting',
  runtime: 'codex',
  snapshotRevision: '100',
  executionState: {
    epoch: 'before-restart',
    revision: '900',
    phase: 'idle',
    turnId: null,
    latestTurnId: 'completed-turn',
    outcome: 'succeeded',
  },
  runtimeHandle: {
    lastTurnId: 'completed-turn',
    threadId: 'native-thread',
    origin: { type: 'project_session', id: 'original-binding' },
    conversationSessions: [{ threadId: 'native-thread' }],
    connectionEventSubscriptions: [{ status: 'armed', error_code: 'connection_unavailable' }],
  },
}
const recovered: RuntimeTaskSummary = {
  ...address,
  title: 'Waiting',
  runtime: 'codex',
  snapshotRevision: '101',
  runtimeHandle: {
    connectionEventSubscriptions: [{ status: 'armed', error_code: null }],
    lastTurnId: 'another-turn',
    threadId: 'another-thread',
    origin: { type: 'unrelated-binding' },
    conversationSessions: [],
  },
}
const work = (task: RuntimeTaskSummary): RuntimeWorkListResponse => ({
  projects: [],
  chats: [{ deviceId: 'device', workspacePath: '/work', tasks: [task] }],
  totalTasks: 1,
})

describe('persistent metadata and native lifecycle ownership', () => {
  const assertRecovered = (task: RuntimeTaskSummary | null | undefined) => {
    expect(task?.executionState).toEqual(previous.executionState)
    expect(task?.snapshotRevision).toBe('101')
    expect(task?.runtimeHandle).toEqual({
      ...previous.runtimeHandle,
      connectionEventSubscriptions: recovered.runtimeHandle!.connectionEventSubscriptions,
    })
  }
  test('refreshing the workbench recovers listener health without replacing native execution', () => {
    let state = workbenchReducer(initialWorkbenchState, {
      type: 'runtime_work_refreshed',
      runtimeWork: work(previous),
    })
    state = workbenchReducer(state, {
      type: 'runtime_work_refreshed',
      runtimeWork: work(recovered),
    })
    assertRecovered(state.runtimeWork?.chats[0].tasks[0])
    state = workbenchReducer(state, { type: 'runtime_work_refreshed', runtimeWork: work(previous) })
    assertRecovered(state.runtimeWork?.chats[0].tasks[0])
  })
  test('local and remote list merges preserve newer metadata in both source orders', () => {
    for (const [first, second] of [
      [previous, recovered],
      [recovered, previous],
    ]) {
      assertRecovered(mergeRuntimeWorkLists(work(first), work(second)).chats[0].tasks[0])
    }
  })
  test('lifecycle consumers accept new metadata and reject a late error snapshot', () => {
    const store = new RuntimeTaskLifecycleStore('event-recovery-metadata')
    store.syncRuntimeTask(address, previous)
    store.syncRuntimeTask(address, recovered)
    assertRecovered(store.getTask(address)?.task)
    store.syncRuntimeTask(address, previous)
    assertRecovered(store.getTask(address)?.task)
  })
  test('updates task permissions without replacing the native execution projection', () => {
    const store = new RuntimeTaskLifecycleStore('permission-metadata')
    const initial: RuntimeTaskSummary = {
      ...previous,
      runtimeHandle: {
        origin: { type: 'stand_in_task', userId: 7 },
        taskPermissions: { permissionMode: 'workspace-write' },
      },
    }
    store.syncRuntimeTask(address, initial)
    store.syncRuntimeTask(address, {
      ...initial,
      snapshotRevision: '101',
      runtimeHandle: { ...initial.runtimeHandle, taskPermissions: { permissionMode: 'read-only' } },
    })
    store.syncRuntimeTask(address, initial)
    expect(store.getTask(address)?.task).toMatchObject({
      executionState: previous.executionState,
      snapshotRevision: '101',
      runtimeHandle: { taskPermissions: { permissionMode: 'read-only' } },
    })
  })
  test('duplicate project and chat projections share metadata without changing the lifecycle winner', () => {
    const project: RuntimeWorkListResponse = {
      projects: [
        {
          project: { id: 7, name: 'Project' },
          deviceWorkspaces: [
            { deviceId: address.deviceId, workspacePath: address.workspacePath, tasks: [previous] },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }
    const merged = mergeRuntimeWorkLists(project, work(recovered))
    const tasks = [
      ...merged.chats,
      ...merged.projects.flatMap(project => project.deviceWorkspaces),
    ].flatMap(workspace => workspace.tasks)
    expect(tasks).toHaveLength(1)
    assertRecovered(tasks[0])
  })
})
