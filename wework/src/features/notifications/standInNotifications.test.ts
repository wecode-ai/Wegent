import { describe, expect, it } from 'vitest'
import { mergeStandInNotifications, standInOrigin, standInState } from './standInNotifications'

import { assignment, runtimeItem } from './standInNotifications.fixtures'
import { RuntimeTaskMachine } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskMachine'

describe('stand-in notification projection', () => {
  it.each(
    ['cloudProjectId', 'loopItemId'].flatMap(field =>
      [undefined, null, '', '   ', 42].map(value => ({ field, value }))
    )
  )(
    'rejects an origin with $field=$value instead of constructing an invalid Issue link',
    ({ field, value }) => {
      const item = {
        ...runtimeItem,
        task: {
          ...runtimeItem.task,
          runtimeHandle: {
            origin: { ...(runtimeItem.task.runtimeHandle!.origin as object), [field]: value },
          },
        },
      }
      expect(standInOrigin(item)).toBeNull()
      expect(mergeStandInNotifications([], [item])).toEqual([])
      expect(mergeStandInNotifications([assignment], [item])).toEqual([assignment])
    }
  )

  it.each([
    ['succeeded', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)('uses the current %s lifecycle over a stale running task', (outcome, expected) => {
    const machine = new RuntimeTaskMachine(runtimeItem.address)
    machine.dispatch({
      type: 'executor_snapshot_received',
      address: runtimeItem.address,
      task: runtimeItem.task,
    })
    machine.dispatch({ type: 'turn_started', turnId: 'turn' })
    machine.dispatch({ type: 'executor_settled' })
    machine.dispatch({ type: 'turn_settled', turnId: 'turn', outcome })
    const item = { ...runtimeItem, lifecycle: machine.getSnapshot() }
    expect(standInState(item).status).toBe(expected)
  })

  it('shows a new running turn over a stale completed task summary', () => {
    const task = { ...runtimeItem.task, running: false, status: 'done' }
    const machine = new RuntimeTaskMachine(runtimeItem.address)
    machine.dispatch({ type: 'executor_snapshot_received', address: runtimeItem.address, task })
    machine.dispatch({ type: 'turn_started', turnId: 'new-turn' })
    const item = { ...runtimeItem, task, lifecycle: machine.getSnapshot() }
    expect(standInState(item).status).toBe('running')
  })

  it.each(['', 'invalid'])('handles invalid creation timestamps: %s', createdAt => {
    const result = mergeStandInNotifications(
      [],
      [{ ...runtimeItem, task: { ...runtimeItem.task, createdAt } }]
    )
    expect(result[0].created_at).toBe('1970-01-01T00:00:00.000Z')
  })
  it('enriches the original assignment without duplicating it or mutating API data', () => {
    const result = mergeStandInNotifications([assignment], [runtimeItem])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('assignment')
    expect(result[0].url).toBe(assignment.url)
    expect(result[0].payload.standIn?.status).toBe('running')
    expect(assignment.url).toBe('wework://boards/12/issues/ISSUE-1')
    expect(assignment.payload).not.toHaveProperty('standIn')
  })

  it('never attaches an execution from another assignment or project', () => {
    for (const changed of [
      { humanAssignmentId: 'human-2' },
      { projectId: '13' },
      { itemId: 'ISSUE-2' },
    ]) {
      const result = mergeStandInNotifications(
        [{ ...assignment, payload: { ...assignment.payload, ...changed } }],
        [runtimeItem]
      )
      expect(result[0].payload.standIn).toBeUndefined()
      expect(result).toHaveLength(2)
    }
  })

  it('keeps every stand-in execution visible when they share one assignment', () => {
    const other = {
      ...runtimeItem,
      key: 'device\0other-task',
      address: { deviceId: 'device', taskId: 'other-task' },
      task: { ...runtimeItem.task, taskId: 'other-task', running: false, status: 'done' },
    }
    const result = mergeStandInNotifications([assignment], [runtimeItem, other])
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe(assignment.id)
    expect(result[0].runtimeItem?.address).toEqual(runtimeItem.address)
    expect(result[0].payload.standIn?.status).toBe('running')
    expect(result[1].synthetic).toBe(true)
    expect(result[1].runtimeItem?.address).toEqual(other.address)
    expect(result[1].payload.standIn?.status).toBe('completed')
    expect(new Set(result.map(item => item.id)).size).toBe(2)
    expect(mergeStandInNotifications([], [runtimeItem, other])).toHaveLength(2)
  })

  it('exposes local stand-ins without a cloud inbox and ignores ordinary tasks', () => {
    const local = {
      ...runtimeItem,
      task: {
        ...runtimeItem.task,
        runtimeHandle: {
          origin: { ...(runtimeItem.task.runtimeHandle!.origin as object), projectStore: 'local' },
        },
      },
    }
    const notification = mergeStandInNotifications([], [local])[0]
    expect(notification.synthetic).toBe(true)
    expect(notification.url).toBe('wework://boards/local/12/issues/ISSUE-1')
    expect(mergeStandInNotifications([], [runtimeItem])[0].url).toBe(assignment.url)
    expect(
      mergeStandInNotifications(
        [],
        [{ ...runtimeItem, task: { ...runtimeItem.task, runtimeHandle: {} } }]
      )
    ).toEqual([])
  })

  it('prioritizes real pending input over the runtime running flag', () => {
    expect(
      standInState({
        ...runtimeItem,
        task: { ...runtimeItem.task, interactionStatus: 'waitingForUserInput' },
      }).status
    ).toBe('waiting')
  })

  it.each([
    ['done', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['queued', 'running'],
  ] as const)('projects %s as %s', (status, expected) => {
    expect(
      standInState({
        ...runtimeItem,
        task: {
          ...runtimeItem.task,
          status,
          running: false,
          ...(status === 'done' ? { completedAt: '2026-10-21T12:03:00Z' } : {}),
        },
      }).status
    ).toBe(expected)
  })
})
