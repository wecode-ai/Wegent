import { describe, expect, it } from 'vitest'
import { mergeStandInNotifications, standInState } from './standInNotifications'

import { assignment, runtimeItem } from './standInNotifications.fixtures'

describe('stand-in notification projection', () => {
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
    expect(result[0].url).toBe('wework://tasks/device/task')
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
    expect(mergeStandInNotifications([], [local])[0].synthetic).toBe(true)
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
