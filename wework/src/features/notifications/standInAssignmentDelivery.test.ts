import { expect, test, vi } from 'vitest'

import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createStandInAssignmentDelivery } from './standInAssignmentDelivery'
import { assignment } from './standInNotifications.fixtures'

vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'main' }))

function setupAssignmentBacklog(count: number) {
  const requests = Array.from({ length: count }, () => Promise.withResolvers<void>())
  let index = 0
  const notifyAssignment = vi.fn<NonNullable<WorkbenchServices['standInApi']>['notifyAssignment']>(
    () => requests[index++].promise
  )
  const readIdentity = vi.fn<NonNullable<WorkbenchServices['getLocalRuntimeSidebarIdentity']>>()
  readIdentity.mockResolvedValue({
    deviceId: 'local',
    runtimeInstanceId: 'runtime',
    provenance: 'local-ipc',
  })
  const services = {
    standInApi: { notifyAssignment },
    getLocalRuntimeSidebarIdentity: readIdentity,
  } as unknown as WorkbenchServices
  const delivery = createStandInAssignmentDelivery('account')
  const input = {
    userId: 7,
    source: { ...EMPTY_RUNTIME_TASK_REMINDERS, services },
    inbox: {
      items: requests.map((_, index) => ({
        ...assignment,
        id: `notification-${index}`,
        payload: { ...assignment.payload, assignmentId: `assignment-${index}` },
      })),
      unread_count: 0,
      next_offset: null,
    },
  }
  return { requests, notifyAssignment, readIdentity, delivery, input }
}

test('replaying an inbox leaves transport capacity for foreground requests and drains all assignments', async () => {
  const { requests, notifyAssignment, delivery, input } = setupAssignmentBacklog(8)
  try {
    delivery.observe(input)
    await vi.waitFor(() => expect(notifyAssignment).toHaveBeenCalled())
    expect(notifyAssignment).toHaveBeenCalledTimes(2)

    for (let index = 0; index < requests.length - 2; index++) {
      requests[index].resolve()
      await vi.waitFor(() => expect(notifyAssignment).toHaveBeenCalledTimes(index + 3))
    }
    for (const request of requests) request.resolve()
    expect(notifyAssignment.mock.calls.map(([, , id]) => id)).toEqual(
      requests.map((_, index) => `assignment-${index}`)
    )
  } finally {
    delivery.release()
  }
})

test('delivery resumes after a transient Executor identity failure between batches', async () => {
  vi.useFakeTimers()
  const { requests, notifyAssignment, readIdentity, delivery, input } = setupAssignmentBacklog(3)
  try {
    delivery.observe(input)
    await vi.advanceTimersByTimeAsync(0)
    expect(notifyAssignment).toHaveBeenCalledTimes(2)

    readIdentity.mockRejectedValueOnce(new Error('Executor restarting'))
    requests[0].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(readIdentity).toHaveBeenCalledTimes(2)
    expect(notifyAssignment).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(notifyAssignment).toHaveBeenNthCalledWith(3, '12', 'ISSUE-1', 'assignment-2', 7, 'local')
  } finally {
    delivery.release()
    for (const request of requests) request.resolve()
    vi.useRealTimers()
  }
})
