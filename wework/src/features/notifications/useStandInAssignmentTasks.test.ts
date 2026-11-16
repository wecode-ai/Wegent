import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { TaskSource } from './NotificationTaskSourceContext'
import type { DeviceInfo } from '@/types/api'
import i18n from '@/i18n'
import { assignment, runtimeItem } from './standInNotifications.fixtures'
import { useStandInNotifications } from './useStandInNotifications'

vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'main' }))
vi.mock('@/desktop/windowFocus', () => ({ isMainWindowFocused: () => true }))
vi.mock('@/features/workbench/runtimeTaskSystemNotifications', () => ({
  sendSystemNotification: vi.fn(),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: i18n.t }) }))
const assignmentTasks = vi.fn()
const identity = vi.fn().mockResolvedValue({ deviceId: 'device' })
const inbox = { items: [assignment], unread_count: 0, next_offset: null }
const archived = { ...runtimeItem.task, running: false, status: 'archived' }
const source: TaskSource = {
  items: [],
  unreadTaskKeys: new Set(),
  markRuntimeTaskRead: vi.fn(),
  userId: 7,
  services: {
    standInApi: { assignmentTasks },
    getLocalRuntimeSidebarIdentity: identity,
  } as unknown as WorkbenchServices,
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  assignmentTasks.mockResolvedValue({ items: [archived] })
})

describe('assignment execution history', () => {
  it.each([false, true])(
    'retains confirmed lookup during inbox refresh (archived: %s)',
    async hasHistory => {
      const items = hasHistory ? [archived] : []
      assignmentTasks.mockResolvedValue({ items })
      const hook = renderHook(
        ({ currentInbox }) => useStandInNotifications(currentInbox, source, 'user', true),
        { initialProps: { currentInbox: inbox } }
      )
      await waitFor(() =>
        expect(hook.result.current.items[0].payload.standInLookupPending).toBe(false)
      )
      const confirmed = hook.result.current.items[0].payload.standIn
      let resolve!: (value: unknown) => void
      assignmentTasks.mockImplementationOnce(
        () =>
          new Promise(done => {
            resolve = done
          })
      )

      hook.rerender({ currentInbox: { ...inbox } })
      await waitFor(() => expect(assignmentTasks).toHaveBeenCalledTimes(2))
      expect(hook.result.current.items[0].payload.standInLookupPending).toBe(false)
      expect(hook.result.current.items[0].payload.standIn).toEqual(confirmed)

      await act(async () => resolve({ items }))
      expect(hook.result.current.items[0].payload.standInLookupPending).toBe(false)
    }
  )

  it('invalidates confirmed history immediately when the runtime API changes', async () => {
    const hook = renderHook(
      ({ current }) => useStandInNotifications(inbox, current, 'user', true),
      { initialProps: { current: source } }
    )
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standIn?.status).toBe('completed')
    )
    let resolve!: (value: unknown) => void
    const replacement = vi.fn(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    hook.rerender({
      current: {
        ...source,
        services: {
          ...source.services,
          standInApi: { ...source.services!.standInApi, assignmentTasks: replacement },
        } as unknown as WorkbenchServices,
      },
    })
    expect(hook.result.current.items[0].payload.standIn).toBeUndefined()
    expect(hook.result.current.items[0].payload.standInLookupPending).toBe(true)
    await waitFor(() => expect(replacement).toHaveBeenCalledOnce())
    await act(async () => resolve({ items: [] }))
    expect(hook.result.current.items[0].payload.standInLookupPending).toBe(false)
  })

  it('retains local history when another online executor fails and deduplicates local aliases', async () => {
    assignmentTasks.mockImplementation(async (_user, deviceId) => {
      if (deviceId === 'remote') throw new Error('Remote unavailable')
      return { items: [archived] }
    })
    const devices = [
      { device_id: 'local-record', app_device_id: 'device', status: 'online' },
      { device_id: 'remote', status: 'online' },
      { device_id: 'offline', status: 'offline' },
    ] as DeviceInfo[]
    const hook = renderHook(() =>
      useStandInNotifications(inbox, { ...source, devices }, 'user', true)
    )
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standIn?.status).toBe('completed')
    )
    expect(assignmentTasks.mock.calls.map(call => call[1])).toEqual(['device', 'remote'])
    expect(hook.result.current.items[0].payload.standInLookupError).toBeUndefined()
  })

  it('queries the native app locally and only usable non-app devices remotely', async () => {
    assignmentTasks.mockImplementation(async (_user, deviceId) => {
      if (deviceId === 'another-app') throw { code: 'remote_control_disabled' }
      return { items: [] }
    })
    const devices = [
      { device_id: 'native-app', app_device_id: 'device', device_type: 'app', status: 'online' },
      { device_id: 'another-app', device_type: 'app', status: 'online' },
      { device_id: 'busy-app', device_type: 'app', status: 'busy' },
      { device_id: 'cloud', device_type: 'cloud', status: 'online' },
      { device_id: 'remote', device_type: 'remote', status: 'busy' },
      { device_id: 'local-executor', device_type: 'local', status: 'online' },
      { device_id: 'offline', device_type: 'remote', status: 'offline' },
      { device_id: 'starting', device_type: 'remote', status: 'starting' },
    ] as DeviceInfo[]
    const hook = renderHook(() =>
      useStandInNotifications(inbox, { ...source, devices }, 'user', true)
    )
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standInLookupPending).toBe(false)
    )
    expect(assignmentTasks.mock.calls.map(call => call[1])).toEqual([
      'device',
      'cloud',
      'remote',
      'local-executor',
    ])
    expect(hook.result.current.items[0].payload.standInLookupError).toBeUndefined()
    expect(hook.result.current.items[0].payload.standIn).toBeUndefined()
  })

  it('persists the failed lookup device and code without recording request or error contents', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      assignmentTasks.mockImplementation(async (_user, deviceId) => {
        if (deviceId === 'broken-executor')
          throw { code: 'unsupported_method', message: 'private error contents', token: 'secret' }
        return { items: [] }
      })
      const devices = [
        { device_id: 'broken-executor', device_type: 'remote', status: 'online' },
      ] as DeviceInfo[]
      const hook = renderHook(() =>
        useStandInNotifications(inbox, { ...source, devices }, 'user', true)
      )
      await waitFor(() =>
        expect(hook.result.current.items[0].payload.standInLookupError).toBeTruthy()
      )
      expect(hook.result.current.items[0].payload.standInLookupError).toBe(
        i18n.t('common:standIn.errors.assignment_lookup_failed', {
          deviceId: 'broken-executor',
          error: i18n.t('common:standIn.errors.executor_update_required'),
        })
      )
      const diagnostic = log.mock.calls.find(
        call => call[0] === '[Wework] Runtime task create diagnostic'
      )
      expect(diagnostic).toBeDefined()
      expect(JSON.parse(diagnostic![1])).toMatchObject({
        stage: 'stand-in-operation-failed',
        operation: 'lookup_assignment_tasks',
        deviceId: 'broken-executor',
        code: 'unsupported_method',
      })
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private error contents|secret|ISSUE-1/)
    } finally {
      log.mockRestore()
    }
  })
  it('restores archived completion after restart without a sidebar or lifecycle entry', async () => {
    const hook = renderHook(() => useStandInNotifications(inbox, source, 'user', true))
    expect(hook.result.current.items[0].payload.standInLookupPending).toBe(true)
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standIn?.status).toBe('completed')
    )
    expect(assignmentTasks).toHaveBeenCalledExactlyOnceWith(7, 'device', [
      {
        projectId: '12',
        itemId: 'ISSUE-1',
        humanAssignmentId: 'human-1',
      },
    ])
    expect(hook.result.current.items).toHaveLength(1)
    expect(hook.result.current.items[0].id).toBe(assignment.id)
    expect(hook.result.current.unreadCount).toBe(0)
  })

  it('keeps live state authoritative and recovers it when the task is archived', async () => {
    const hook = renderHook(
      ({ current }) => useStandInNotifications(inbox, current, 'user', true),
      {
        initialProps: { current: { ...source, items: [runtimeItem] } },
      }
    )
    await waitFor(() => expect(assignmentTasks).toHaveBeenCalledOnce())
    expect(hook.result.current.items[0].payload.standIn?.status).toBe('running')
    hook.rerender({ current: source })
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standIn?.status).toBe('completed')
    )
    expect(hook.result.current.items).toHaveLength(1)
  })

  it('does not treat old work as handling a new assignment or retain a previous account response', async () => {
    let resolve!: (value: unknown) => void
    assignmentTasks.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    const hook = renderHook(
      ({ account, currentInbox }) => useStandInNotifications(currentInbox, source, account, true),
      {
        initialProps: { account: 'old', currentInbox: inbox },
      }
    )
    await waitFor(() => expect(assignmentTasks).toHaveBeenCalledOnce())
    assignmentTasks.mockResolvedValue({ items: [] })
    hook.rerender({
      account: 'new',
      currentInbox: {
        ...inbox,
        items: [
          { ...assignment, payload: { ...assignment.payload, humanAssignmentId: 'new-human' } },
        ],
      },
    })
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standInLookupPending).toBe(false)
    )
    await act(async () => resolve({ items: [archived] }))
    expect(hook.result.current.items[0].payload.standIn).toBeUndefined()
    expect(hook.result.current.items).toHaveLength(1)
  })

  it('exposes lookup errors and recovers on inbox refresh', async () => {
    assignmentTasks.mockRejectedValueOnce(new Error('History unavailable'))
    const hook = renderHook(
      ({ currentInbox }) => useStandInNotifications(currentInbox, source, 'user', true),
      {
        initialProps: { currentInbox: inbox },
      }
    )
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standInLookupError).toBeTruthy()
    )
    expect(hook.result.current.items[0].payload.standIn).toBeUndefined()
    hook.rerender({ currentInbox: { ...inbox } })
    await waitFor(() =>
      expect(hook.result.current.items[0].payload.standIn?.status).toBe('completed')
    )
    expect(hook.result.current.items[0].payload.standInLookupError).toBeUndefined()
  })

  it.each(['account', 'assignment'] as const)(
    'hides resolved history immediately when only the %s scope changes',
    async changed => {
      const hook = renderHook(
        ({ account, currentInbox }) => useStandInNotifications(currentInbox, source, account, true),
        { initialProps: { account: 'old', currentInbox: inbox } }
      )
      await waitFor(() =>
        expect(hook.result.current.items[0].payload.standIn?.status).toBe('completed')
      )
      let complete!: (value: { items: [] }) => void
      assignmentTasks.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            complete = resolve
          })
      )
      hook.rerender({
        account: changed === 'account' ? 'new' : 'old',
        currentInbox:
          changed === 'assignment'
            ? {
                ...inbox,
                items: [
                  {
                    ...assignment,
                    payload: { ...assignment.payload, humanAssignmentId: 'new-human' },
                  },
                ],
              }
            : inbox,
      })
      expect(hook.result.current.items[0].payload.standIn).toBeUndefined()
      expect(hook.result.current.items[0].payload.standInLookupPending).toBe(true)
      await waitFor(() => expect(assignmentTasks).toHaveBeenCalledTimes(2))
      await act(async () => complete({ items: [] }))
      expect(hook.result.current.items[0].payload.standInLookupPending).toBe(false)
    }
  )
})
