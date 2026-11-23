import { expect, test, vi } from 'vitest'

import { EMPTY_RUNTIME_TASK_REMINDERS } from '@/features/workbench/runtimeTaskReminders'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createStandInAssignmentDelivery } from './standInAssignmentDelivery'
import { assignment } from './standInNotifications.fixtures'

vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'main' }))

test('replaying an inbox leaves transport capacity for foreground requests and drains all assignments', async () => {
  const requests = Array.from({ length: 8 }, () => Promise.withResolvers<void>())
  let index = 0
  const notifyAssignment = vi.fn<NonNullable<WorkbenchServices['standInApi']>['notifyAssignment']>(
    () => requests[index++].promise
  )
  const services = {
    standInApi: { notifyAssignment },
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'local' }),
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
