import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeworkInbox } from '@/api/notifications'
import type { TaskSource } from './NotificationTaskSourceContext'
import type { DeviceInfo } from '@/types/devices'
import { assignment } from './standInNotifications.fixtures'
import { useStandInAssignmentNotifications } from './useStandInAssignmentNotifications'

const { windowLabel } = vi.hoisted(() => ({ windowLabel: vi.fn(() => 'main') }))
vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: windowLabel }))

function fixture() {
  const notifyAssignment = vi.fn().mockResolvedValue(undefined)
  const identity = vi.fn().mockResolvedValue({ deviceId: 'mac' })
  const source = {
    services: { standInApi: { notifyAssignment }, getLocalRuntimeSidebarIdentity: identity },
  } as unknown as TaskSource
  const inbox: WeworkInbox = {
    items: [{ ...assignment, payload: { ...assignment.payload, assignmentId: 'assignment' } }],
    unread_count: 0,
    next_offset: null,
  }
  return { notifyAssignment, identity, source, inbox }
}

beforeEach(() => {
  windowLabel.mockReturnValue('main')
})

describe('automatic stand-in assignment notifications', () => {
  it('uses the already loaded inbox and ignores repeated refreshes and read markers', async () => {
    const { notifyAssignment, source, inbox } = fixture()
    const hook = renderHook(
      ({ inbox }) => useStandInAssignmentNotifications(inbox, source, 'account', 7),
      { initialProps: { inbox } }
    )
    await waitFor(() => expect(notifyAssignment).toHaveBeenCalledOnce())
    expect(notifyAssignment).toHaveBeenCalledWith(
      assignment.payload.projectId,
      assignment.payload.itemId,
      'assignment',
      7,
      'mac'
    )
    hook.rerender({
      inbox: { ...inbox, items: inbox.items.map(item => ({ ...item, read_at: 'read' })) },
    })
    expect(notifyAssignment).toHaveBeenCalledOnce()
    hook.rerender({
      inbox: { ...inbox, items: [...inbox.items, { ...inbox.items[0], id: 'new-assignment' }] },
    })
    await waitFor(() => expect(notifyAssignment).toHaveBeenCalledTimes(2))
  })

  it('waits for services and account identity without consuming notifications', async () => {
    const { notifyAssignment, source, inbox } = fixture()
    const hook = renderHook(
      ({ source, userId }: { source: TaskSource | null; userId: number | null }) =>
        useStandInAssignmentNotifications(inbox, source, 'account', userId),
      { initialProps: { source: null as TaskSource | null, userId: null as number | null } }
    )
    expect(notifyAssignment).not.toHaveBeenCalled()
    hook.rerender({ source, userId: 7 })
    await waitFor(() => expect(notifyAssignment).toHaveBeenCalledOnce())
  })

  it('reports execution failure without retrying on every inbox refresh', async () => {
    const { notifyAssignment, source, inbox } = fixture()
    const failure = new Error('Executor unavailable')
    notifyAssignment.mockRejectedValue(failure)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const hook = renderHook(
        ({ inbox }) => useStandInAssignmentNotifications(inbox, source, 'account', 7),
        { initialProps: { inbox } }
      )
      await waitFor(() =>
        expect(log).toHaveBeenCalledWith('[Stand-in] Assignment notification failed', {
          notificationId: assignment.id,
          deviceId: 'mac',
          error: failure,
        })
      )
      hook.rerender({ inbox: { ...inbox } })
      expect(notifyAssignment).toHaveBeenCalledOnce()
    } finally {
      log.mockRestore()
    }
  })

  it('handles a newly connected remote device once and deduplicates local aliases', async () => {
    const { notifyAssignment, source, inbox } = fixture()
    const device = (device_id: string, status: DeviceInfo['status'], app_device_id?: string) =>
      ({ device_id, status, app_device_id }) as DeviceInfo
    const hook = renderHook(
      ({ devices }) =>
        useStandInAssignmentNotifications(inbox, { ...source, devices }, 'account', 7),
      {
        initialProps: {
          devices: [device('local-alias', 'online', 'mac'), device('remote', 'offline')],
        },
      }
    )
    await waitFor(() => expect(notifyAssignment).toHaveBeenCalledOnce())
    hook.rerender({ devices: [device('local-alias', 'online', 'mac'), device('remote', 'online')] })
    await waitFor(() => expect(notifyAssignment).toHaveBeenCalledTimes(2))
    expect(notifyAssignment).toHaveBeenLastCalledWith(
      assignment.payload.projectId,
      assignment.payload.itemId,
      'assignment',
      7,
      'remote'
    )
    hook.rerender({ devices: [device('remote', 'online')] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notifyAssignment).toHaveBeenCalledTimes(2)
  })

  it('does not trigger from auxiliary windows or unrelated notifications', () => {
    const { notifyAssignment, identity, source, inbox } = fixture()
    windowLabel.mockReturnValue('workspace-1')
    const hook = renderHook(() => useStandInAssignmentNotifications(inbox, source, 'account', 7))
    expect(identity).not.toHaveBeenCalled()
    hook.unmount()
    windowLabel.mockReturnValue('main')
    renderHook(() =>
      useStandInAssignmentNotifications(
        {
          ...inbox,
          items: [
            { ...inbox.items[0], kind: 'mention' },
            { ...inbox.items[0], payload: {} },
          ],
        },
        source,
        'account',
        7
      )
    )
    expect(identity).not.toHaveBeenCalled()
    expect(notifyAssignment).not.toHaveBeenCalled()
  })
})
