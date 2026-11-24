import { expect, test } from 'vitest'
import {
  activeStandInBranchRows,
  groupStandInDelegations,
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
})
