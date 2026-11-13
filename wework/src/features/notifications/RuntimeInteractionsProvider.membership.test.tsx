// Register provider mocks before importing modules that consume them.
import { context, harness, view } from './runtimeInteractionsProvider.fixtures'
import { act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TaskSource } from './NotificationTaskSourceContext'
import {
  markRuntimeConversationArchived,
  runtimeConversationKey,
  unmarkRuntimeConversationArchived,
} from '@/features/workbench/runtimeConversationCacheStore'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'

describe('pending interaction membership and read cache', () => {
  it('reports a failed first device inventory read even when no pending work has been cached', async () => {
    const rendered = view(interactionQuestion, interactionTask, false, undefined, false)
    await waitFor(() => expect(context!.loading).toBe(false))
    harness.list.mockRejectedValue(new Error('Inventory transport unavailable'))
    rendered.rerenderSource({
      ...rendered.taskSource,
      devices: [
        { device_id: 'device', status: 'online' } as NonNullable<TaskSource['devices']>[number],
      ],
    })
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.errors['inventory:device']).toBe('interactions.load_failed')
    expect(context!.pending).toHaveLength(0)
  })
  it('removes confirmed archived work even when its device goes offline before inventory reconciliation', async () => {
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    const rendered = view(interactionQuestion, interactionTask, false, undefined, false)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const reads = harness.transcript.mock.calls.length
    const key = runtimeConversationKey(interactionTask.address)
    markRuntimeConversationArchived(key)
    try {
      harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
      rendered.rerenderSource({
        ...rendered.taskSource,
        devices: [
          { device_id: 'device', status: 'offline' } as NonNullable<TaskSource['devices']>[number],
        ],
        services: {
          ...rendered.taskSource.services!,
          getLocalRuntimeSidebarIdentity: async () => ({
            deviceId: 'local',
            runtimeInstanceId: 'local',
            provenance: 'local-ipc',
          }),
        },
      })
      await act(async () => {
        await context!.refresh()
      })
      expect(context!.pending).toHaveLength(0)
      expect(context!.errors).toEqual({})
      expect(harness.transcript).toHaveBeenCalledTimes(reads)
      expect(JSON.parse(localStorage.getItem('wework.interactions:test:1:pending')!)).toEqual([])
    } finally {
      unmarkRuntimeConversationArchived(key)
    }
  })
  it.each(['removed', 'archived', 'stale-inventory'])(
    'retires cached questions and load errors for a %s task after a healthy inventory refresh',
    async status => {
      const rendered = view()
      await waitFor(() => expect(context!.pending).toHaveLength(1))
      harness.transcript.mockRejectedValue(new Error('thread is archived'))
      await act(async () => {
        await context!.refresh()
      })
      expect(context!.errors[interactionTask.key]).toBe('interactions.load_failed')
      const reads = harness.transcript.mock.calls.length
      if (status === 'stale-inventory') {
        harness.list.mockResolvedValue({
          projects: [],
          chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
          totalTasks: 1,
        })
      }
      rendered.rerenderSource({
        ...rendered.taskSource,
        items:
          status !== 'removed'
            ? [{ ...interactionTask, task: { ...interactionTask.task, status: 'archived' } }]
            : [],
        devices: [
          { device_id: 'device', status: 'online' } as NonNullable<TaskSource['devices']>[number],
        ],
      })
      await act(async () => {
        await context!.refresh()
      })
      expect(harness.transcript).toHaveBeenCalledTimes(reads)
      expect(context!.pending).toHaveLength(0)
      expect(context!.errors).toEqual({})
      await act(async () => {
        await context!.refresh()
      })
      expect(harness.transcript).toHaveBeenCalledTimes(reads)
      expect(JSON.parse(localStorage.getItem('wework.interactions:test:1:pending')!)).toEqual([])
      harness.transcript.mockResolvedValue(interactionTranscript())
      rendered.rerenderSource(rendered.taskSource)
      await waitFor(() => expect(context!.pending).toHaveLength(1))
    }
  )

  it('does not cache failed history reads or summaries without a timestamp', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const intervals = vi.spyOn(window, 'setInterval')
    const rendered = view(interactionQuestion, interactionTask, false, new Error('offline'))
    await waitFor(() => expect(context!.loading).toBe(false))
    expect(log).toHaveBeenCalledWith(
      '[Wework] Runtime task create diagnostic',
      expect.stringContaining('"stage":"pending-interaction-load-failed"')
    )
    const entry = JSON.parse(
      log.mock.calls.find(
        ([, value]) =>
          typeof value === 'string' && value.includes('pending-interaction-load-failed')
      )![1] as string
    )
    expect(entry).toMatchObject({
      operation: 'transcript',
      deviceId: interactionTask.address.deviceId,
      taskId: interactionTask.address.taskId,
      error: { name: 'Error', message: 'offline' },
    })
    const poll = intervals.mock.calls.find(([, ms]) => ms === 5000)![0] as () => void
    harness.transcript.mockResolvedValue(interactionTranscript())
    await act(async () => {
      poll()
    })
    expect(context!.pending[0].requestKey).not.toBe('unavailable')
    const withoutTimestamp = {
      ...interactionTask,
      task: { ...interactionTask.task, updatedAt: undefined },
    }
    rendered.rerenderSource({ ...rendered.taskSource, items: [withoutTimestamp] })
    await waitFor(() => expect(context!.loading).toBe(false))
    const reads = harness.transcript.mock.calls.length
    await act(async () => {
      poll()
    })
    expect(harness.transcript).toHaveBeenCalledTimes(reads + 1)
  })

  it('invalidates history cache when the service changes or a device recovers', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const intervals = vi.spyOn(window, 'setInterval')
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const reads = harness.transcript.mock.calls.length
    const newService = {
      ...rendered.taskSource,
      services: {
        ...rendered.taskSource.services!,
        runtimeWorkApi: {
          ...rendered.taskSource.services!.runtimeWorkApi!,
        },
        getLocalRuntimeSidebarIdentity: async () => ({
          deviceId: 'local',
          runtimeInstanceId: 'local-runtime',
          provenance: 'local-ipc',
        }),
      },
    }
    rendered.rerenderSource(newService)
    await waitFor(() => expect(harness.transcript).toHaveBeenCalledTimes(reads + 1))
    const offline = {
      ...newService,
      devices: [
        { device_id: 'device', status: 'offline' } as NonNullable<TaskSource['devices']>[number],
      ],
    }
    rendered.rerenderSource(offline)
    const poll = intervals.mock.calls.filter(([, ms]) => ms === 5000).at(-1)![0] as () => void
    await act(async () => {
      poll()
    })
    const offlineLogs = () =>
      log.mock.calls.filter(
        ([, value]) => typeof value === 'string' && value.includes('Device is marked offline')
      )
    expect(offlineLogs()).toHaveLength(1)
    expect(JSON.parse(offlineLogs()[0][1] as string)).toMatchObject({
      operation: 'inventory',
      deviceId: 'device',
    })
    await act(async () => {
      poll()
    })
    expect(offlineLogs()).toHaveLength(1)
    const beforeRecovery = harness.transcript.mock.calls.length
    rendered.rerenderSource({ ...offline, devices: [{ ...offline.devices[0], status: 'online' }] })
    // Inventory polling owns device availability and invalidates the previous successful read.
    await act(async () => {
      poll()
    })
    expect(harness.transcript).toHaveBeenCalledTimes(beforeRecovery + 1)
  })
})
