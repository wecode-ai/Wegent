import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { NotificationTaskContext, type TaskSource } from './NotificationTaskSourceContext'
import { RuntimeInteractionsProvider } from './RuntimeInteractionsProvider'
import { RuntimeInteractionNotice } from './RuntimeInteractionNotice'
import { RuntimeInteractionsPage } from './RuntimeInteractionsPage'
import { useRuntimeInteractions } from './RuntimeInteractionsContext'
import {
  cacheNotificationPreferences,
  defaultNotificationPreferences,
} from './notificationPreferences'
import {
  interactionQuestion,
  interactionTask,
  interactionTranscript,
} from './runtimeInteractions.fixtures'

const harness = vi.hoisted(() => ({
  t: (key: string) => key,
  tabs: {
    tabs: [],
    activeTab: { kind: 'board', contentRoute: '/todo' },
    openTab: vi.fn(),
    selectTab: vi.fn(),
  },
  locks: new Map<string, Promise<unknown>>(),
  desktop: false,
  focused: true,
  focusListeners: new Set<(focused: boolean) => void>(),
  host: vi.fn(),
  hostListeners: new Set<(event: { type: string }) => void>(),
  transcript: vi.fn(),
  send: vi.fn(),
  guide: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  list: vi.fn(),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: harness.t }) }))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => harness.tabs,
}))
vi.mock('@/desktop/windowFocus', () => ({
  isMainWindowFocused: () => harness.focused,
  subscribeMainWindowFocus: (listener: (focused: boolean) => void) => {
    harness.focusListeners.add(listener)
    return () => harness.focusListeners.delete(listener)
  },
}))
vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => harness.desktop,
  getDesktopWindowLabel: () => 'main',
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: harness.host,
  subscribeDesktopHostEvents: (listener: (event: { type: string }) => void) => {
    harness.hostListeners.add(listener)
    return () => harness.hostListeners.delete(listener)
  },
}))

let context: ReturnType<typeof useRuntimeInteractions>
function Probe() {
  const value = useRuntimeInteractions()
  useEffect(() => {
    context = value
  }, [value])
  return null
}

function UnrelatedForm() {
  const [value, setValue] = useState('')
  return (
    <input aria-label="Connection address" value={value} onChange={e => setValue(e.target.value)} />
  )
}
function view(
  payload = interactionQuestion,
  task = interactionTask,
  active = false,
  initialError?: Error,
  listed = true,
  running = false
) {
  if (initialError) harness.transcript.mockRejectedValue(initialError)
  else harness.transcript.mockResolvedValue({ ...interactionTranscript(payload), running })
  const services = {
    runtimeWorkApi: {
      getRuntimeTranscript: harness.transcript,
      sendRuntimeMessage: harness.send,
      guideRuntimeTask: harness.guide,
      listRuntimeWork: harness.list,
    },
  } as unknown as WorkbenchServices
  const taskSource: TaskSource = {
    items: listed ? [task] : [],
    services,
    unreadTaskKeys: new Set(),
    markRuntimeTaskRead: harness.read,
    refresh: harness.refresh,
  }
  const tree = (taskSource: TaskSource, accountKey = 'test:1') => (
    <NotificationTaskContext.Provider value={{ taskSource, registerTaskSource: () => {} }}>
      <RuntimeInteractionsProvider accountKey={accountKey}>
        <Probe />
        <RuntimeInteractionNotice />
        <RuntimeInteractionsPage active={active} />
      </RuntimeInteractionsProvider>
    </NotificationTaskContext.Provider>
  )
  const rendered = render(tree(taskSource))
  return {
    ...rendered,
    taskSource,
    rerenderSource: (source: TaskSource, accountKey?: string) =>
      rendered.rerender(tree(source, accountKey)),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.locks.clear()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (name: string, callback: () => unknown) => {
        const previous = harness.locks.get(name) ?? Promise.resolve()
        const next = previous.catch(() => undefined).then(callback)
        harness.locks.set(name, next)
        return next
      },
    },
  })
  harness.focused = true
  harness.focusListeners.clear()
  harness.desktop = false
  harness.hostListeners.clear()
  harness.host.mockReset()
  localStorage.clear()
  harness.send.mockResolvedValue({ accepted: true })
  harness.guide.mockResolvedValue({ accepted: true })
  harness.refresh.mockResolvedValue(undefined)
  harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'locks')
})

describe('unified human response', () => {
  it.each([true, false])(
    'serializes replies across provider instances and permits retry only after failure (accepted=%s)',
    async accepted => {
      harness.list.mockResolvedValue({
        projects: [],
        chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
        totalTasks: 1,
      })
      view()
      await waitFor(() => expect(context!.pending).toHaveLength(1))
      const first = context!
      view()
      await waitFor(() => expect(context).not.toBe(first))
      await waitFor(() => expect(context!.pending[0]?.cached).not.toBe(true))
      const second = context!
      let finish!: (result: { accepted: boolean }) => void
      harness.send.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      let firstReply!: Promise<boolean>, secondReply!: Promise<boolean>
      act(() => {
        firstReply = first.respond(first.pending[0], 'first answer')
      })
      await waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))
      act(() => {
        secondReply = second.respond(second.pending[0], 'second answer')
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(harness.send).toHaveBeenCalledTimes(1)
      await act(async () => {
        finish({ accepted })
        expect(await firstReply).toBe(accepted)
        expect(await secondReply).toBe(!accepted)
      })
      expect(harness.send).toHaveBeenCalledTimes(accepted ? 1 : 2)
    }
  )

  it('settles a stale response without an error after its acceptance marker has been cleaned', async () => {
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const item = context!.pending[0]
    await act(async () => {
      expect(await context!.respond(item, 'first answer')).toBe(true)
    })
    const marker = Object.keys(localStorage).find(key => key.includes(':accepted:'))!
    expect(marker).toBeTruthy()
    localStorage.removeItem(marker)
    act(() => context!.setDraft(item.id, 'stale second answer'))
    await act(async () => {
      expect(await context!.respond(item, 'stale second answer')).toBe(false)
    })
    expect(harness.send).toHaveBeenCalledTimes(1)
    expect(context!.errors).toEqual({})
    expect(context!.drafts[item.id]).toBeUndefined()
  })

  it('bounds unchanged history scans while forcing explicit refresh and summary changes', async () => {
    const intervals = vi.spyOn(window, 'setInterval')
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const poll = intervals.mock.calls.find(([, ms]) => ms === 5000)![0] as () => void
    const initialReads = harness.transcript.mock.calls.length
    await act(async () => {
      poll()
    })
    expect(harness.transcript).toHaveBeenCalledTimes(initialReads)
    await act(async () => {
      await context!.refresh()
    })
    expect(harness.transcript).toHaveBeenCalledTimes(initialReads + 1)
    rendered.rerenderSource({
      ...rendered.taskSource,
      items: [
        {
          ...interactionTask,
          task: { ...interactionTask.task, updatedAt: '2026-10-30T00:00:01Z' },
        },
      ],
    })
    await waitFor(() => expect(harness.transcript).toHaveBeenCalledTimes(initialReads + 2))
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 30_001)
    await act(async () => {
      poll()
    })
    expect(harness.transcript).toHaveBeenCalledTimes(initialReads + 3)
  })

  it('does not cache failed history reads or summaries without a timestamp', async () => {
    const intervals = vi.spyOn(window, 'setInterval')
    const rendered = view(interactionQuestion, interactionTask, false, new Error('offline'))
    await waitFor(() => expect(context!.loading).toBe(false))
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
    const beforeRecovery = harness.transcript.mock.calls.length
    rendered.rerenderSource({ ...offline, devices: [{ ...offline.devices[0], status: 'online' }] })
    // Inventory polling owns device availability and invalidates the previous successful read.
    await act(async () => {
      poll()
    })
    expect(harness.transcript).toHaveBeenCalledTimes(beforeRecovery + 1)
  })

  it('expires a request during a cached poll without reloading unchanged history', async () => {
    const intervals = vi.spyOn(window, 'setInterval')
    const now = Date.now()
    view({ ...interactionQuestion, expiresAtUnixMs: now + 1000 })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const reads = harness.transcript.mock.calls.length
    const poll = intervals.mock.calls.find(([, ms]) => ms === 5000)![0] as () => void
    vi.spyOn(Date, 'now').mockReturnValue(now + 1001)
    await act(async () => {
      poll()
    })
    expect(context!.pending).toHaveLength(0)
    expect(harness.transcript).toHaveBeenCalledTimes(reads)
  })

  it('acknowledges an accepted native reply after a refresh replaces its effect', async () => {
    harness.desktop = true
    let accept!: (result: { accepted: boolean }) => void
    harness.send.mockImplementation(
      () =>
        new Promise(resolve => {
          accept = resolve
        })
    )
    let replies = [{ id: 'native-1', interactionId: '', text: 'keep' }]
    harness.host.mockImplementation(async (command: string) => {
      if (command === 'notification.pendingReplies') return replies[0]?.interactionId ? replies : []
      if (command === 'notification.acknowledgeReply') replies = []
    })
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    replies[0].interactionId = context!.pending[0].id
    act(() => harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' })))
    await waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))
    await act(async () => {
      await context!.refresh()
    })
    await act(async () => {
      accept({ accepted: true })
    })
    await waitFor(() =>
      expect(harness.host).toHaveBeenCalledWith('notification.acknowledgeReply', {
        id: 'native-1',
        accountKey: 'test:1',
      })
    )
    expect(replies).toEqual([])
    expect(harness.send).toHaveBeenCalledTimes(1)
  })

  it('keeps a native reply queued until the pending cache regains live response authority', async () => {
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const id = context!.pending[0].id
    first.unmount()
    harness.desktop = true
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    let replies = [{ id: 'native-startup', interactionId: id, text: 'keep' }]
    harness.host.mockImplementation(async (command: string) => {
      if (command === 'notification.pendingReplies') return replies
      if (command === 'notification.acknowledgeReply') replies = []
    })
    let load!: (value: ReturnType<typeof interactionTranscript>) => void
    harness.transcript.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          load = resolve
        })
    )
    let accept!: (value: { accepted: boolean }) => void
    harness.send.mockImplementation(
      () =>
        new Promise(resolve => {
          accept = resolve
        })
    )
    view()
    await waitFor(() =>
      expect(harness.host).toHaveBeenCalledWith('notification.pendingReplies', {
        accountKey: 'test:1',
      })
    )
    await waitFor(() => expect(load).toBeTypeOf('function'))
    try {
      expect(context!.pending[0]?.cached).toBe(true)
      expect(harness.send).not.toHaveBeenCalled()
      expect(harness.host).not.toHaveBeenCalledWith(
        'notification.acknowledgeReply',
        expect.anything()
      )
    } finally {
      await act(async () => {
        load(interactionTranscript())
      })
    }
    await waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))
    expect(harness.host).not.toHaveBeenCalledWith(
      'notification.acknowledgeReply',
      expect.anything()
    )
    await act(async () => {
      accept({ accepted: true })
    })
    await waitFor(() => expect(replies).toEqual([]))
    expect(harness.send).toHaveBeenCalledTimes(1)
    expect(harness.host).toHaveBeenCalledWith('notification.acknowledgeReply', {
      id: 'native-startup',
      accountKey: 'test:1',
    })
  })

  it.each([true, false])(
    'retries native acknowledgement without resending or replacing a draft (accepted=%s)',
    async accepted => {
      harness.desktop = true
      harness.send.mockResolvedValue({ accepted, error: accepted ? undefined : 'rejected' })
      const intervals = vi.spyOn(window, 'setInterval')
      let replies = [{ id: 'native-1', interactionId: '', text: 'keep' }]
      let failed = false
      harness.host.mockImplementation(async (command: string) => {
        if (command === 'notification.pendingReplies')
          return replies[0]?.interactionId ? replies : []
        if (command === 'notification.acknowledgeReply') {
          if (!failed) {
            failed = true
            throw new Error('host unavailable')
          }
          replies = []
        }
      })
      view()
      await waitFor(() => expect(context!.pending).toHaveLength(1))
      const id = context!.pending[0].id
      replies[0].interactionId = id
      act(() => harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' })))
      await waitFor(() => expect(failed).toBe(true))
      if (!accepted) act(() => context!.setDraft(id, 'edited after failure'))
      const poll = intervals.mock.calls.filter(([, ms]) => ms === 5000).at(-1)![0] as () => void
      await act(async () => {
        poll()
      })
      await waitFor(() => expect(replies).toEqual([]))
      expect(harness.send).toHaveBeenCalledTimes(1)
      if (!accepted) expect(context!.drafts[id]).toBe('edited after failure')
    }
  )

  it('does not replay a failed native answer or overwrite its draft after renderer reload', async () => {
    harness.desktop = true
    harness.send.mockResolvedValue({ accepted: false, error: 'rejected' })
    let replies = [{ id: 'native-reload', interactionId: '', text: 'original native text' }]
    let failedAcknowledgement = false
    harness.host.mockImplementation(async (command: string) => {
      if (command === 'notification.pendingReplies') return replies[0]?.interactionId ? replies : []
      if (command === 'notification.acknowledgeReply') {
        if (!failedAcknowledgement) {
          failedAcknowledgement = true
          throw new Error('host unavailable')
        }
        replies = []
      }
    })
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const id = context!.pending[0].id
    replies[0].interactionId = id
    act(() => harness.hostListeners.forEach(listener => listener({ type: 'notification-reply' })))
    await waitFor(() => expect(failedAcknowledgement).toBe(true))
    act(() => context!.setDraft(id, 'edited before reload'))
    first.unmount()
    view()
    await waitFor(() => expect(replies).toEqual([]))
    expect(harness.send).toHaveBeenCalledTimes(1)
    expect(context!.drafts[id]).toBe('edited before reload')
    expect(context!.history).toEqual([])
  })

  it('keeps an accepted old-account reply out of the new account state', async () => {
    let accept!: (result: { accepted: boolean }) => void
    harness.send.mockImplementation(
      () =>
        new Promise(resolve => {
          accept = resolve
        })
    )
    const rendered = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    let reply!: Promise<boolean>
    act(() => {
      reply = context!.respond(context!.pending[0], 'keep')
    })
    await waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1))
    rendered.rerenderSource({ ...rendered.taskSource, items: [] }, 'test:2')
    await act(async () => {
      accept({ accepted: true })
      expect(await reply).toBe(true)
    })
    expect(context!.history).toEqual([])
    expect(context!.drafts).toEqual({})
    expect(context!.busy.size).toBe(0)
    expect(context!.errors).toEqual({})
    expect(context!.notice).toBeNull()
  })

  it('isolates account drafts without remounting unrelated application UI', async () => {
    const tree = (accountKey: string) => (
      <RuntimeInteractionsProvider accountKey={accountKey}>
        <Probe />
        <UnrelatedForm />
      </RuntimeInteractionsProvider>
    )
    const rendered = render(tree('cloud-a:1'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Connection address' }), {
      target: { value: 'http://127.0.0.1:1' },
    })
    act(() => context!.setDraft('request-a', 'private answer'))
    expect(context!.drafts).toEqual({ 'request-a': 'private answer' })

    rendered.rerender(tree('cloud-b:1'))
    expect(context!.drafts).toEqual({})
    expect(screen.getByRole('textbox', { name: 'Connection address' })).toHaveValue(
      'http://127.0.0.1:1'
    )
    expect(localStorage.getItem('wework.interactions:cloud-b:1:drafts')).not.toContain(
      'private answer'
    )

    rendered.rerender(tree('cloud-a:1'))
    expect(context!.drafts).toEqual({ 'request-a': 'private answer' })
    expect(screen.getByRole('textbox', { name: 'Connection address' })).toHaveValue(
      'http://127.0.0.1:1'
    )
  })

  it('delivers one shared stand-in reminder and keeps its request after dismissal', async () => {
    view(interactionQuestion, {
      ...interactionTask,
      task: {
        ...interactionTask.task,
        runtimeHandle: { origin: { type: 'stand_in_work', initiatedBy: 'stand_in' } },
      },
    })
    await waitFor(() => expect(screen.getAllByTestId('runtime-interaction-notice')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('interaction-notice-dismiss'))
    await act(async () => {
      await context!.refresh()
    })
    expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    expect(context!.pending).toHaveLength(1)
    expect(harness.send).not.toHaveBeenCalled()
  })
  it('retains a remote cache until that exact device has been queried, including startup enumeration', async () => {
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const id = context!.pending[0].id
    first.unmount()
    harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
    const restarted = view(interactionQuestion, interactionTask, false, undefined, false)
    await act(async () => {
      await context!.refresh()
    })
    await waitFor(() => expect(context!.loading).toBe(false))
    expect(context!.pending[0]?.id).toBe(id)
    expect(context!.pending[0]?.cached).toBe(true)
    expect(JSON.parse(localStorage.getItem('wework.interactions:test:1:pending')!)).toHaveLength(1)
    const offline = {
      ...restarted.taskSource,
      devices: [
        { device_id: 'device', status: 'offline' } as NonNullable<TaskSource['devices']>[number],
      ],
    }
    restarted.rerenderSource(offline)
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0]?.id).toBe(id)
    expect(screen.queryByTestId('interaction-reply')).not.toBeInTheDocument()
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    restarted.rerenderSource({ ...offline, devices: [{ ...offline.devices[0], status: 'online' }] })
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0]?.id).toBe(id)
    expect(context!.pending[0]?.cached).not.toBe(true)
    expect(screen.getByTestId('interaction-reply')).toBeInTheDocument()
  })
  it('restores last-known pending work and its draft offline without granting cached response authority', async () => {
    const first = view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const id = context!.pending[0].id
    act(() => context!.setDraft(id, 'Keep existing behavior'))
    first.unmount()
    harness.list.mockRejectedValue(new Error('Device offline'))
    view(interactionQuestion, interactionTask, false, new Error('Device offline'), false)
    await waitFor(() => expect(context!.pending[0]?.cached).toBe(true))
    expect(context!.drafts[id]).toBe('Keep existing behavior')
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'Keep existing behavior')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    harness.transcript.mockResolvedValue(interactionTranscript())
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0].cached).not.toBe(true)
    expect(context!.drafts[id]).toBe('Keep existing behavior')
  })
  it('retains a hidden request while its device is offline and restores answering after recovery', async () => {
    const work = {
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    }
    harness.list.mockResolvedValue(work)
    const rendered = view(interactionQuestion, interactionTask, false, undefined, false)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    const offline = {
      ...rendered.taskSource,
      devices: [
        { device_id: 'device', status: 'offline' } as NonNullable<TaskSource['devices']>[number],
      ],
    }
    harness.list.mockResolvedValue({ projects: [], chats: [], totalTasks: 0 })
    rendered.rerenderSource(offline)
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending).toHaveLength(1)
    expect(context!.pending[0].task.workspace.available).toBe(false)
    expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
    harness.list.mockResolvedValue(work)
    rendered.rerenderSource({ ...offline, devices: [{ ...offline.devices[0], status: 'online' }] })
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending).toHaveLength(1)
    expect(screen.queryByTestId('interaction-open-original-action')).not.toBeInTheDocument()
    expect(harness.send).not.toHaveBeenCalled()
  })
  it('discovers pending work even when no corresponding task is listed in the sidebar', async () => {
    harness.list.mockResolvedValue({
      projects: [],
      chats: [{ ...interactionTask.workspace, tasks: [interactionTask.task] }],
      totalTasks: 1,
    })
    view(interactionQuestion, interactionTask, false, undefined, false)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    expect(harness.list).toHaveBeenCalledWith({ pendingOnly: true, deviceId: undefined })
    expect(context!.pending[0].task.address).toMatchObject({
      deviceId: interactionTask.address.deviceId,
      taskId: interactionTask.address.taskId,
    })
    expect(harness.read).not.toHaveBeenCalled()
  })
  it('suppresses a reminder only when its exact question is already visible', async () => {
    view(interactionQuestion, interactionTask, true)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    act(() => context!.registerView('other-pane', 'another-question'))
    expect(context!.pending).toHaveLength(1)
  })

  it('guides a running async task and accepts the guidance API success response', async () => {
    harness.guide.mockResolvedValue({ success: true })
    const task = {
      ...interactionTask,
      lifecycle: { turn: { active: true } },
    } as typeof interactionTask
    view(interactionQuestion, task, false, undefined, true, true)
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
    })
    expect(harness.guide).toHaveBeenCalledWith(
      expect.objectContaining({ address: interactionTask.address, message: 'keep' })
    )
    expect(harness.send).not.toHaveBeenCalled()
    expect(context!.pending).toHaveLength(0)
  })

  it('queues an async answer when an active goal has no confirmed running turn', async () => {
    view(interactionQuestion, {
      ...interactionTask,
      task: {
        ...interactionTask.task,
        running: false,
        status: 'queued',
        goalStatus: 'active',
      },
    })
    harness.transcript.mockResolvedValue({
      ...interactionTranscript(),
      running: undefined,
    })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
    })
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'keep', queueIfBusy: true })
    )
    expect(harness.guide).not.toHaveBeenCalled()
    expect(context!.pending).toHaveLength(0)
  })

  it.each([false, true])(
    'preserves the owning remote model configuration (handle only: %s)',
    async handleOnly => {
      const modelSelection = {
        modelName: 'team-review-model',
        modelType: 'user' as const,
        options: { reasoning: 'high', weworkCloudModelNamespace: 'team' },
      }
      const task = {
        ...interactionTask,
        task: {
          ...interactionTask.task,
          ...(handleOnly ? { runtimeHandle: { modelSelection } } : { modelSelection }),
        },
      }
      view(interactionQuestion, task)
      await waitFor(() => expect(context!.pending).toHaveLength(1))
      await act(async () => {
        expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
      })
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSelection,
          modelId: modelSelection.modelName,
          modelOptions: modelSelection.options,
        })
      )
    }
  )

  it('keeps an actionable pending entry when the first transcript read fails, then recovers', async () => {
    const viewResult = view(
      interactionQuestion,
      interactionTask,
      false,
      new Error('Device offline')
    )
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending).toHaveLength(1)
    expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
    expect(harness.send).not.toHaveBeenCalled()
    harness.transcript.mockResolvedValue(interactionTranscript())
    await act(async () => {
      await context!.refresh()
    })
    expect(context!.pending[0].question).toBe('Keep existing customer behavior?')
    viewResult.unmount()
  })
  it('delivers once on return when no channel could deliver while inactive', async () => {
    harness.focused = false
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    act(() => harness.focusListeners.forEach(listener => listener(true)))
    await screen.findByTestId('runtime-interaction-notice')
    fireEvent.click(screen.getByTestId('interaction-notice-dismiss'))
    act(() => harness.focusListeners.forEach(listener => listener(false)))
    act(() => harness.focusListeners.forEach(listener => listener(true)))
    expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    expect(context!.pending).toHaveLength(1)
  })

  it.each([false, true])('uses only available reminder channels (desktop=%s)', async desktop => {
    harness.desktop = desktop
    harness.focused = false
    cacheNotificationPreferences('test:1', {
      ...defaultNotificationPreferences,
      tasks: { ...defaultNotificationPreferences.tasks, system: true },
    })
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    if (desktop) {
      await waitFor(() =>
        expect(harness.host).toHaveBeenCalledWith(
          'notification.show',
          expect.objectContaining({ body: 'Keep existing customer behavior?' })
        )
      )
    } else {
      expect(harness.host).not.toHaveBeenCalledWith('notification.show', expect.anything())
    }
    act(() => harness.focusListeners.forEach(listener => listener(true)))
    if (desktop) expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    else await screen.findByTestId('runtime-interaction-notice')
  })

  it('keeps pending work when a reminder is dismissed or opened, independently of unread', async () => {
    view()
    await screen.findByTestId('runtime-interaction-notice')
    fireEvent.click(screen.getByTestId('interaction-notice-dismiss'))
    expect(screen.queryByTestId('runtime-interaction-notice')).not.toBeInTheDocument()
    expect(context!.pending).toHaveLength(1)
    expect(screen.getByTestId('interactions-pending-count')).toHaveTextContent('1')
    expect(harness.read).not.toHaveBeenCalled()
    act(() => context!.open(context!.pending[0].id))
    expect(harness.tabs.openTab).toHaveBeenCalledWith(
      'auxiliary',
      expect.objectContaining({ id: 'pending-interactions' })
    )
    expect(context!.pending).toHaveLength(1)
  })

  it('sends an async answer as a user message and removes it only after acceptance', async () => {
    view()
    await screen.findByTestId('runtime-interaction-notice')
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(true)
    })
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'keep', queueIfBusy: true })
    )
    expect(harness.send.mock.calls[0][0]).not.toHaveProperty('requestUserInputResponse')
    expect(context!.pending).toHaveLength(0)
    expect(context!.history).toHaveLength(1)
  })

  it('preserves a rejected response and its draft, then permits a real retry', async () => {
    harness.send.mockResolvedValueOnce({ accepted: false, error: 'Rejected' })
    view()
    await screen.findByTestId('runtime-interaction-notice')
    const item = context!.pending[0]
    act(() => context!.setDraft(item.id, 'Keep existing configuration'))
    await act(async () => {
      expect(await context!.respond(item, 'Keep existing configuration')).toBe(false)
    })
    expect(context!.pending).toHaveLength(1)
    expect(context!.history).toHaveLength(0)
    expect(context!.drafts[item.id]).toBe('Keep existing configuration')
    expect(context!.errors[item.id]).toBe('interactions.failed')
    await act(async () => {
      expect(await context!.respond(item, 'Keep existing configuration')).toBe(true)
    })
    expect(harness.send.mock.calls[1][0].clientUserMessageId).toBe(
      harness.send.mock.calls[0][0].clientUserMessageId
    )
    expect(context!.pending).toHaveLength(0)
  })

  it('answers a synchronous request with its identity instead of creating a user turn', async () => {
    view({ ...interactionQuestion, delivery: undefined, requestId: 22, interactionScope: 'turn-1' })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      await context!.respond(context!.pending[0], 'keep')
    })
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUserInputResponse: expect.objectContaining({
          requestId: 22,
          interactionScope: 'turn-1',
          answers: { compatibility: { answers: ['keep'] } },
        }),
      })
    )
  })

  it('never turns an execution approval into an ordinary reply', async () => {
    view({ ...interactionQuestion, approvalKind: 'command' })
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'Allow')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
    expect(screen.getByTestId('interaction-open-original-action')).toBeInTheDocument()
  })

  it('revalidates a request already answered in its original conversation', async () => {
    view()
    await waitFor(() => expect(context!.pending).toHaveLength(1))
    harness.transcript.mockResolvedValue(
      interactionTranscript({ ...interactionQuestion, interactionStatus: 'answered' })
    )
    await act(async () => {
      expect(await context!.respond(context!.pending[0], 'keep')).toBe(false)
    })
    expect(harness.send).not.toHaveBeenCalled()
  })
})
