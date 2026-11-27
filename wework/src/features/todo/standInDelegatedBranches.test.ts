import { expect, test } from 'vitest'
import type { RemoteStandInRoleBranch } from '@/api/standIn'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import {
  activeStandInBranchRows,
  groupStandInDelegations,
  selectStandInDelegatedWork,
  standInDelegationsByMessage,
  type Branch,
} from './standInDelegatedBranches'

const time = (seconds: number) => Date.UTC(2026, 10, 24, 0, 0, seconds)
const branch = (root: string, seconds: number, status: Branch['status']): Branch => ({
  root,
  taskId: String(seconds),
  title: root,
  createdAt: time(seconds),
  ancestors: ['assistant'],
  parentId: 'assistant',
  dispatcherDeviceId: 'device',
  status,
  attempt: 0,
  retryAllowed: false,
})

test('delegations stay with their original request across later requests and status changes', () => {
  const requests = [
    { id: 'second', role: 'user' as const, createdAt: new Date(time(20)).toISOString() },
    { id: 'first', role: 'user' as const, createdAt: new Date(time(5)).toISOString() },
    {
      id: 'internal-result',
      role: 'user' as const,
      createdAt: new Date(time(7)).toISOString(),
      source: { source: 'stand_in_activity' },
    },
  ]
  const groups = groupStandInDelegations([
    branch('delegation-two', 25, 'running'),
    branch('delegation-one', 21, 'completed'),
    branch('delegation-one', 10, 'completed'),
    branch('outside-loaded-history', 3, 'completed'),
  ])

  const cards = standInDelegationsByMessage(requests, groups)
  expect([...cards].map(([message, groups]) => [message, groups.map(group => group.root)])).toEqual(
    [
      ['first', ['delegation-one']],
      ['second', ['delegation-two']],
    ]
  )
  expect(cards.get('first')?.[0]?.branches).toHaveLength(2)
  expect(groups).toHaveLength(3)
})

test('a delegated parent stays in the active list until its child finishes', () => {
  const parent = branch('root', 10, 'completed')
  const child = {
    ...branch('root', 11, 'running'),
    parentId: parent.taskId,
    ancestors: ['assistant', parent.taskId],
  }

  expect(activeStandInBranchRows([parent, child]).map(row => row.status)).toEqual([
    'waitingChildren',
    'running',
  ])
  expect(activeStandInBranchRows([parent, { ...child, status: 'completed' }])).toEqual([])
  expect(
    activeStandInBranchRows([{ ...parent, completionConfirmed: true }, child]).map(
      row => row.status
    )
  ).toEqual(['running'])
})

function delegatedTask(
  status: 'running' | 'done' | 'failed',
  attempt = 0,
  remote = false
): RuntimeTaskReminderItem {
  const deviceId = remote ? 'worker' : 'dispatcher'
  const taskId = 'delegated'
  return {
    key: taskId,
    address: { deviceId, taskId },
    task: {
      taskId,
      title: 'Delegated task',
      runtime: 'codex',
      workspacePath: '',
      status,
      running: status === 'running',
      runtimeHandle: {
        origin: {
          type: 'stand_in_task',
          userId: 7,
          deviceId,
          sourceTaskId: 'assistant',
          ...(remote ? { sourceDeviceId: 'dispatcher' } : {}),
          roleDelegation: { root: 'root', ancestors: ['assistant'], rootDevice: 'dispatcher' },
        },
        executionRequest: { standInDelegation: { attempt } },
      },
    },
    workspace: { deviceId, available: true, workspacePath: '', tasks: [] },
    projectName: '',
  }
}

const dispatcherBranch: RemoteStandInRoleBranch = {
  taskId: 'delegated',
  createdAt: new Date(time(10)).toISOString(),
  root: 'root',
  title: 'Delegated task',
  deviceId: 'dispatcher',
  parentTaskId: 'assistant',
  ancestors: ['assistant'],
  taskAddress: { deviceId: 'dispatcher', taskId: 'delegated' },
  status: 'done',
  attempt: 0,
  retryAllowed: false,
}

function select(item: RuntimeTaskReminderItem, remote: RemoteStandInRoleBranch) {
  return selectStandInDelegatedWork([item], [remote], 7, 'dispatcher', 'assistant', new Map())[0]
}

test('preserves dispatcher completion despite a stale task reminder', () => {
  expect(select(delegatedTask('running'), dispatcherBranch)).toMatchObject({
    status: 'completed',
    completionConfirmed: true,
  })
  expect(
    select(delegatedTask('running', 0, true), {
      ...dispatcherBranch,
      deviceId: 'worker',
      taskAddress: { deviceId: 'worker', taskId: 'delegated' },
    })
  ).toMatchObject({ status: 'completed', completionConfirmed: true })
})

test('uses the current local execution status while preserving old dispatcher compatibility', () => {
  const running = { ...dispatcherBranch, status: 'running' as const }
  expect(
    select(delegatedTask('done'), { ...running, statusSource: 'local_execution' }).status
  ).toBe('running')
  const waiting = select(delegatedTask('done'), {
    ...running,
    statusSource: 'local_execution',
    waitingForChildren: true,
  })
  expect(activeStandInBranchRows([waiting]).map(row => row.status)).toEqual(['waitingChildren'])
  expect(select(delegatedTask('done'), { ...running, status: 'dispatched' }).status).toBe(
    'completed'
  )
})

test('does not overwrite a newer retry with results from the previous attempt', () => {
  expect(
    select(delegatedTask('done'), {
      ...dispatcherBranch,
      attempt: 1,
      status: 'retrying',
    })
  ).toMatchObject({ status: 'retrying', attempt: 1 })
  expect(
    select(delegatedTask('running', 1), { ...dispatcherBranch, retryAllowed: true })
  ).toMatchObject({
    status: 'running',
    attempt: 1,
    retryAllowed: false,
    completionConfirmed: undefined,
  })
})
